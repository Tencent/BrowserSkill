import {
  createDiagnosticRecorder,
  DIAGNOSTIC_STORAGE_KEY,
  type DiagnosticRecorder,
  setDiagnosticRecorder,
} from "./connection-diagnostics";

export const DIAGNOSTIC_ENABLED_KEY = "bsk_connection_diagnostics_enabled";
export const DIAGNOSTIC_CONTROL_KIND = "bsk:connection-diagnostics";

interface DiagnosticsStorage {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}
export type DiagnosticCommand =
  | { kind: typeof DIAGNOSTIC_CONTROL_KIND; action: "set-enabled"; enabled: boolean }
  | { kind: typeof DIAGNOSTIC_CONTROL_KIND; action: "clear" };

/** Background owns writes and control ordering; the options page only reads events. */
export function startConnectionDiagnostics(
  storage: DiagnosticsStorage,
  options: { bootId: string; build: string },
) {
  let active: DiagnosticRecorder | null = null;
  setDiagnosticRecorder(null);
  async function start(initialEvent: "worker.start" | "diagnostics.enabled") {
    if (active) return;
    active = createDiagnosticRecorder(
      {
        read: async () => (await storage.get(DIAGNOSTIC_STORAGE_KEY))[DIAGNOSTIC_STORAGE_KEY],
        write: (snapshot) => storage.set({ [DIAGNOSTIC_STORAGE_KEY]: snapshot }),
      },
      { ...options, initialEvent },
    );
    setDiagnosticRecorder(active);
    await active.flush();
  }
  async function stop() {
    setDiagnosticRecorder(null);
    const previous = active;
    active = null;
    await previous?.flush();
  }
  // Connection startup never waits for this optional preference or event storage.
  const ready = Promise.resolve()
    .then(() => storage.get(DIAGNOSTIC_ENABLED_KEY))
    .then(async (items) => {
      if (items[DIAGNOSTIC_ENABLED_KEY] === true) await start("worker.start");
    })
    .catch(() => {
      // An unreadable preference must not silently opt the user in.
    });
  let tail = ready;
  function control(command: DiagnosticCommand): Promise<void> {
    const next = tail.then(async () => {
      if (command.action === "set-enabled" && command.enabled) {
        await storage.set({ [DIAGNOSTIC_ENABLED_KEY]: true });
        await start("diagnostics.enabled");
      } else {
        await stop();
        await storage.set({ [DIAGNOSTIC_ENABLED_KEY]: false });
        if (command.action === "clear") await storage.remove(DIAGNOSTIC_STORAGE_KEY);
      }
    });
    // A failed explicit command is reported to its caller without poisoning later controls.
    tail = next.catch(() => {});
    return next;
  }
  return { ready, control };
}

/** Only explicit controls from this extension may wake/manage its recorder. */
export function handleDiagnosticMessage(
  runtime: { control(command: DiagnosticCommand): Promise<void> },
  message: unknown,
  senderId: string | undefined,
  extensionId: string,
  reply: (response: { ok: boolean }) => void,
): boolean {
  if (senderId !== extensionId || !message || typeof message !== "object") return false;
  const command = message as Partial<DiagnosticCommand>;
  if (command.kind !== DIAGNOSTIC_CONTROL_KIND) return false;
  if (
    command.action !== "clear" &&
    !(command.action === "set-enabled" && typeof command.enabled === "boolean")
  )
    return false;
  const respond = (ok: boolean) => {
    try {
      reply({ ok });
    } catch {
      /* The options page may have closed. */
    }
  };
  void runtime.control(command as DiagnosticCommand).then(
    () => respond(true),
    () => respond(false),
  );
  return true;
}
