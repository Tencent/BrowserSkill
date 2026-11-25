import { browserVideoHost } from "@/video/host";
import type { CdpDebuggerApi } from "./chromium-cdp";
import { type NativeClockSample, NativeInputClockError } from "./native-input-clock";

const TIMEOUT_MS = 5_000;
// Confined to our hidden document. Keep the probe positive even when the
// browser's cached epoch projects current timestamps far into the past.
const PROBE_AHEAD_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const probes = new WeakMap<CdpDebuggerApi, Promise<NativeClockSample[] | null>>();
const restrictedApis = new WeakSet<CdpDebuggerApi>();

function isTransientProbeUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already attached|No target with given id|target.*closed|single offscreen|disconnected/i.test(
    message,
  );
}

/** Use the same offscreen lifetime/lease as video so neither owner can close
 * the other's document. No tab is created, focused or used for calibration.
 * Returns `null` when the runtime cannot open, discover, or attach to the
 * extension's offscreen probe target (e.g. Chrome 157+ packed/policy builds),
 * where `InputHandler` already anchors CDP input timestamps dynamically per dispatch. */
export function sampleNativeInputClock(api: CdpDebuggerApi): Promise<NativeClockSample[] | null> {
  if (
    restrictedApis.has(api) ||
    !api.getTargets ||
    typeof chrome === "undefined" ||
    !chrome.offscreen ||
    !chrome.runtime?.getURL
  ) {
    restrictedApis.add(api);
    return Promise.resolve(null);
  }
  const existing = probes.get(api);
  if (existing) return existing;
  const getTargets = api.getTargets.bind(api);
  let expired = false;
  let enteredDocument = false;
  let attached = false;
  let target: chrome.debugger.Debuggee | undefined;
  const check = () => {
    if (expired) throw new NativeInputClockError("Native input clock calibration timed out");
  };
  const rawWork = browserVideoHost.withDocument(async () => {
    enteredDocument = true;
    const url = chrome.runtime.getURL("video-offscreen.html");
    let targets: chrome.debugger.TargetInfo[];
    try {
      targets = await getTargets();
    } catch (error) {
      check();
      if (!isTransientProbeUnavailable(error)) restrictedApis.add(api);
      return null;
    }
    check();
    const info = targets.find((item) => item.url === url && item.extensionId === chrome.runtime.id);
    if (!info) {
      const live = await chrome.offscreen.hasDocument().catch(() => false);
      check();
      if (live) restrictedApis.add(api);
      return null;
    }
    if (info.attached) return null;
    target = { targetId: info.id };
    const send = async <T>(method: string, params: object = {}): Promise<T> => {
      check();
      const value = await api.sendCommand(target!, method, params);
      check();
      return value as T;
    };
    const evaluate = async <T>(expression: string): Promise<T> => {
      const result = await send<{ result?: { value?: T }; exceptionDetails?: unknown }>(
        "Runtime.evaluate",
        { expression, returnByValue: true },
      );
      if (result.exceptionDetails || result.result?.value === undefined)
        throw new NativeInputClockError("Native clock document did not answer");
      return result.result.value;
    };
    const key = `bskClock${crypto.randomUUID()}`;
    const token = JSON.stringify(key);
    const property = JSON.stringify("__bskNativeInputClock");
    try {
      try {
        await api.attach(target, "1.3");
      } catch (error) {
        check();
        if (!isTransientProbeUnavailable(error)) {
          restrictedApis.add(api);
        }
        return null;
      }
      attached = true;
      check();
      await send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await evaluate(`(() => {
        globalThis[${property}]?.dispose();
        const samples = [];
        const listen = event => {
          if (!event.isTrusted || event.key !== 'F24') return;
          const before = performance.now();
          const wall = Date.now();
          const after = performance.now();
          samples.push({ eventTimestamp: event.timeStamp, before, wall, after });
          if (samples.length > 1) samples.shift();
        };
        document.addEventListener('keydown', listen, true);
        globalThis[${property}] = {
          id: ${token},
          take: () => samples.shift() ?? null,
          dispose: () => document.removeEventListener('keydown', listen, true)
        };
        return true;
      })()`);
      const samples: NativeClockSample[] = [];
      for (let index = 0; index < 7; index++) {
        const timestamp = Date.now() + PROBE_AHEAD_MS;
        try {
          await send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "F24",
            code: "F24",
            windowsVirtualKeyCode: 135,
            timestamp: timestamp / 1000,
          });
        } finally {
          if (!expired)
            await send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "F24",
              code: "F24",
              windowsVirtualKeyCode: 135,
            });
        }
        const sample = await evaluate<Omit<NativeClockSample, "timestamp"> | null>(
          `globalThis[${property}]?.id === ${token} ? globalThis[${property}].take() : null`,
        );
        if (!sample) throw new NativeInputClockError("Native clock probe did not produce an event");
        samples.push({ ...sample, timestamp });
      }
      return samples;
    } finally {
      if (attached) {
        if (!expired)
          await api
            .sendCommand(target, "Runtime.evaluate", {
              expression: `if (globalThis[${property}]?.id === ${token}) {
                globalThis[${property}].dispose(); delete globalThis[${property}];
              }`,
            })
            .catch(() => {});
        // Detaching also drops focus emulation and fences any late native command.
        await api.detach(target).catch(() => {});
        attached = false;
      }
    }
  });
  const work = rawWork.catch((error: unknown) => {
    if (enteredDocument || expired) throw error;
    if (!isTransientProbeUnavailable(error)) restrictedApis.add(api);
    return null;
  });
  let timer: ReturnType<typeof setTimeout>;
  const result = Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        if (attached && target) void api.detach(target).catch(() => {});
        reject(new NativeInputClockError("Native input clock calibration timed out"));
      }, TIMEOUT_MS);
    }),
  ]).catch((error: unknown) => {
    throw error instanceof NativeInputClockError
      ? error
      : new NativeInputClockError(
          `Native input clock calibration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
  });
  probes.set(api, result);
  // A timed-out attach can still finish. Keep its lease until the real work
  // settles; a new caller must not attach over its late cleanup.
  void work
    .finally(() => {
      clearTimeout(timer);
      if (probes.get(api) === result) probes.delete(api);
    })
    .catch(() => {});
  return result;
}
