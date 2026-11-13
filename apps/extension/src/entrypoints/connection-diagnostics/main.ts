import { DIAGNOSTIC_STORAGE_KEY, type DiagnosticSnapshot } from "../../lib/connection-diagnostics";
import {
  DIAGNOSTIC_CONTROL_KIND,
  DIAGNOSTIC_ENABLED_KEY,
  type DiagnosticCommand,
} from "../../lib/connection-diagnostics-runtime";

const status = document.getElementById("status")!;
const log = document.getElementById("log")!;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const buttons = ["start", "stop", "refresh", "download", "clear"].map(button);
let saved: DiagnosticSnapshot | null = null;
let firstReadAt: string | null = null;
function busy() {
  for (const item of buttons) item.disabled = true;
}

async function read(): Promise<void> {
  firstReadAt ??= new Date().toISOString();
  busy();
  try {
    const stored = await chrome.storage.local.get([DIAGNOSTIC_ENABLED_KEY, DIAGNOSTIC_STORAGE_KEY]);
    const enabled = stored[DIAGNOSTIC_ENABLED_KEY] === true;
    const value = stored[DIAGNOSTIC_STORAGE_KEY] as DiagnosticSnapshot | undefined;
    saved = value?.schema === 1 && Array.isArray(value.events) ? value : null;
    log.textContent = saved ? JSON.stringify(saved, null, 2) : "";
    status.textContent = `${enabled ? "Recording on" : "Recording off"}. ${
      saved
        ? `${saved.events.length} events; ${saved.droppedEvents} dropped; ${saved.readFailures} read failures; ${saved.writeFailures} write failures. Snapshot: ${saved.capturedAt}.`
        : "No valid stored log; this does not prove that the background was inactive."
    } First read: ${firstReadAt}.`;
    button("start").disabled = enabled;
    button("stop").disabled = !enabled;
    button("download").disabled = saved === null;
  } catch {
    saved = null;
    log.textContent = "";
    status.textContent =
      "Unable to read stored diagnostics. Preserve the failure state and try reading again.";
    button("stop").disabled = false;
  } finally {
    button("refresh").disabled = false;
    button("clear").disabled = false;
  }
}

async function control(command: DiagnosticCommand): Promise<void> {
  busy();
  let failed = false;
  try {
    const response = await chrome.runtime.sendMessage(command);
    if (response?.ok !== true) failed = true;
  } catch {
    failed = true;
  }
  await read();
  if (failed)
    status.textContent = "Unable to change diagnostics. Read stored state before trying again.";
}

button("start").addEventListener("click", () => {
  void control({ kind: DIAGNOSTIC_CONTROL_KIND, action: "set-enabled", enabled: true });
});
button("stop").addEventListener("click", () => {
  void control({ kind: DIAGNOSTIC_CONTROL_KIND, action: "set-enabled", enabled: false });
});
button("clear").addEventListener("click", () => {
  void control({ kind: DIAGNOSTIC_CONTROL_KIND, action: "clear" });
});
button("refresh").addEventListener("click", () => {
  void read();
});
button("download").addEventListener("click", () => {
  if (!saved) return;
  const exportedAt = new Date().toISOString();
  const blob = new Blob(
    [JSON.stringify({ readerSchema: 1, firstReadAt, exportedAt, snapshot: saved }, null, 2)],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `bsk-connection-diagnostics-${exportedAt.replace(/[:.]/g, "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});
void read();
