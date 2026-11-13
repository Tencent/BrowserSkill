import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DIAGNOSTIC_STORAGE_KEY } from "../connection-diagnostics";
import { DIAGNOSTIC_CONTROL_KIND, DIAGNOSTIC_ENABLED_KEY } from "../connection-diagnostics-runtime";

const snapshot = {
  schema: 1,
  capturedAt: "2026-10-17T00:00:00.000Z",
  droppedEvents: 0,
  readFailures: 0,
  writeFailures: 0,
  events: [{ bootId: "boot-a", type: "worker.start" }],
};
let get: ReturnType<typeof vi.fn>;
let sendMessage: ReturnType<typeof vi.fn>;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const loaded = () => vi.waitFor(() => expect(button("refresh").disabled).toBe(false));
beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML =
    '<p id="status"></p><pre id="log"></pre><button id="refresh" disabled>Read</button><button id="download" disabled>Export</button><button id="start" disabled>Start</button><button id="stop" disabled>Stop</button><button id="clear" disabled>Clear and stop</button>';
  get = vi.fn(async () => ({
    [DIAGNOSTIC_ENABLED_KEY]: false,
    [DIAGNOSTIC_STORAGE_KEY]: structuredClone(snapshot),
  }));
  sendMessage = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("chrome", { storage: { local: { get } }, runtime: { sendMessage } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("initial read and refresh only read storage, leaving the worker untouched", async () => {
  await import("../../entrypoints/connection-diagnostics/main");
  await loaded();
  expect(get).toHaveBeenCalledWith([DIAGNOSTIC_ENABLED_KEY, DIAGNOSTIC_STORAGE_KEY]);
  expect(document.getElementById("log")!.textContent).toContain("boot-a");
  expect(button("start").disabled).toBe(false);
  expect(button("stop").disabled).toBe(true);
  button("refresh").click();
  await loaded();
  expect(get).toHaveBeenCalledTimes(2);
  expect(sendMessage).not.toHaveBeenCalled();
});

it("exports a stored snapshot and timestamps only after explicit download", async () => {
  let exported!: Blob;
  const create = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    exported = blob as Blob;
    return "blob:test";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await import("../../entrypoints/connection-diagnostics/main");
  await loaded();
  expect(create).not.toHaveBeenCalled();
  button("download").click();
  expect(click).toHaveBeenCalledOnce();
  const data = JSON.parse(await exported.text());
  expect(data.snapshot).toEqual(snapshot);
  expect(data.firstReadAt).toMatch(/^\d{4}-/);
  expect(data.exportedAt).toMatch(/^\d{4}-/);
  expect(sendMessage).not.toHaveBeenCalled();
});

it("only sends a recording control on explicit start and locks controls while pending", async () => {
  let finish!: (value: { ok: boolean }) => void;
  sendMessage.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        finish = yes;
      }),
  );
  await import("../../entrypoints/connection-diagnostics/main");
  await loaded();
  button("start").click();
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
    kind: DIAGNOSTIC_CONTROL_KIND,
    action: "set-enabled",
    enabled: true,
  });
  expect(button("start").disabled).toBe(true);
  expect(button("clear").disabled).toBe(true);
  get.mockResolvedValue({ [DIAGNOSTIC_ENABLED_KEY]: true, [DIAGNOSTIC_STORAGE_KEY]: snapshot });
  finish({ ok: true });
  await loaded();
  expect(button("stop").disabled).toBe(false);
  button("stop").click();
  await loaded();
  expect(sendMessage).toHaveBeenLastCalledWith({
    kind: DIAGNOSTIC_CONTROL_KIND,
    action: "set-enabled",
    enabled: false,
  });
});

it("clears through the background command, without direct storage mutations", async () => {
  await import("../../entrypoints/connection-diagnostics/main");
  await loaded();
  get.mockResolvedValue({ [DIAGNOSTIC_ENABLED_KEY]: false });
  button("clear").click();
  await loaded();
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
    kind: DIAGNOSTIC_CONTROL_KIND,
    action: "clear",
  });
  expect(button("download").disabled).toBe(true);
  expect(document.getElementById("log")!.textContent).toBe("");
});

it("reports read failures without displaying arbitrary storage error text", async () => {
  get.mockRejectedValue(new Error("PRIVATE"));
  await import("../../entrypoints/connection-diagnostics/main");
  await loaded();
  expect(document.getElementById("status")!.textContent).toContain("Unable to read");
  expect(document.body.textContent).not.toContain("PRIVATE");
  expect(button("download").disabled).toBe(true);
  expect(sendMessage).not.toHaveBeenCalled();
});

it("shows failed controls as errors even when refreshing stored state succeeds", async () => {
  sendMessage.mockResolvedValue({ ok: false });
  await import("../../entrypoints/connection-diagnostics/main");
  await loaded();
  button("start").click();
  await loaded();
  expect(document.getElementById("status")!.textContent).toContain("Unable to change");
  expect(button("start").disabled).toBe(false);
});
