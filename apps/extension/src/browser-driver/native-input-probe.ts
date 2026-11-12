import { browserVideoHost } from "@/video/host";
import type { CdpDebuggerApi } from "./chromium-cdp";
import { type NativeClockSample, NativeInputClockError } from "./native-input-clock";

const TIMEOUT_MS = 5_000;
// Confined to our hidden document. Keep the probe positive even when the
// browser's cached epoch projects current timestamps far into the past.
const PROBE_AHEAD_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const probes = new WeakMap<CdpDebuggerApi, Promise<NativeClockSample[]>>();

/** Use the same offscreen lifetime/lease as video so neither owner can close
 * the other's document. No tab is created, focused or used for calibration. */
export function sampleNativeInputClock(api: CdpDebuggerApi): Promise<NativeClockSample[]> {
  const existing = probes.get(api);
  if (existing) return existing;
  let expired = false;
  let attached = false;
  let target: chrome.debugger.Debuggee | undefined;
  const check = () => {
    if (expired) throw new NativeInputClockError("Native input clock calibration timed out");
  };
  const work = browserVideoHost.withDocument(async () => {
    if (!api.getTargets) throw new NativeInputClockError("Native clock discovery is unavailable");
    const url = chrome.runtime.getURL("video-offscreen.html");
    const info = (await api.getTargets()).find(
      (item) => item.url === url && item.extensionId === chrome.runtime.id,
    );
    check();
    if (!info || info.attached)
      throw new NativeInputClockError("Native clock document is unavailable");
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
      await api.attach(target, "1.3");
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
