import { afterEach, expect, it, vi } from "vitest";
import { watchPopupFocus } from "../popup-focus";

afterEach(() => vi.unstubAllGlobals());

async function fixture(focused = 1, state = "normal") {
  const listeners = new Set<(id: number) => void>();
  const bounds = new Set<(window: chrome.windows.Window) => void>();
  const windows = {
    getAll: async () => [
      { id: 1, focused: focused === 1 },
      { id: 10, focused: focused === 10, state },
    ],
    get: vi.fn(async (id: number) => ({ id })),
    update: vi.fn(async () => {}),
    onFocusChanged: {
      addListener: (fn: (id: number) => void) => listeners.add(fn),
      removeListener: (fn: (id: number) => void) => listeners.delete(fn),
    },
    onBoundsChanged: {
      addListener: (fn: (window: chrome.windows.Window) => void) => bounds.add(fn),
      removeListener: (fn: (window: chrome.windows.Window) => void) => bounds.delete(fn),
    },
  };
  vi.stubGlobal("chrome", { windows });
  const guard = await watchPopupFocus(10);
  const focus = (id: number) => {
    for (const listener of listeners) listener(id);
  };
  guard.arm();
  return { windows, guard, focus, listeners, bounds };
}

it("restores a user window after Chrome activates an observed task popup", async () => {
  const f = await fixture();
  f.focus(10);
  await f.guard.finish(() => true);
  expect(f.windows.update).toHaveBeenCalledExactlyOnceWith(1, { focused: true });
  expect(f.listeners.size + f.bounds.size).toBe(0);
});

it("restores a minimized task window without selecting a user tab", async () => {
  const f = await fixture(1, "minimized");
  f.focus(10);
  await f.guard.finish(() => true);
  expect(f.windows.update).toHaveBeenCalledExactlyOnceWith(10, { state: "minimized" });
});

it.each([
  "normal",
  "minimized",
])("allows an intermediate no-window focus event (%s)", async (state) => {
  const f = await fixture(1, state);
  f.focus(-1);
  f.focus(10);
  await f.guard.finish(() => true);
  expect(f.windows.update).toHaveBeenCalledExactlyOnceWith(
    state === "minimized" ? 10 : 1,
    state === "minimized" ? { state: "minimized" } : { focused: true },
  );
});

it("leaves focus outside Chrome when the no-window event is final", async () => {
  const f = await fixture();
  f.focus(10);
  f.focus(-1);
  await f.guard.finish(() => true);
  expect(f.windows.update).not.toHaveBeenCalled();
});

it("respects a switch to another Chrome window after a no-window event", async () => {
  const f = await fixture();
  f.focus(-1);
  f.focus(2);
  f.focus(-1);
  f.focus(10);
  await f.guard.finish(() => true);
  expect(f.windows.update).not.toHaveBeenCalled();
});

it.each([-1, 10])("does not activate another window when original focus was %s", async (id) => {
  const f = await fixture(id);
  f.focus(10);
  await f.guard.finish(() => true);
  expect(f.windows.update).not.toHaveBeenCalled();
});

it("respects a user focus change during an input operation", async () => {
  const f = await fixture();
  f.focus(2);
  f.focus(10);
  await f.guard.finish(() => true);
  expect(f.windows.update).not.toHaveBeenCalled();
});

it("checks focus again after looking up the previous window", async () => {
  const f = await fixture();
  f.focus(10);
  f.windows.get.mockImplementationOnce(async (id) => {
    f.focus(-1);
    return { id };
  });
  await f.guard.finish(() => true);
  expect(f.windows.update).not.toHaveBeenCalled();
});

it("does not restore focus without an observed task popup", async () => {
  const f = await fixture();
  f.focus(10);
  await f.guard.finish(() => false);
  expect(f.windows.update).not.toHaveBeenCalled();
  expect(f.listeners.size + f.bounds.size).toBe(0);
});

it("does not restore focus after the input operation is cancelled", async () => {
  const f = await fixture();
  f.focus(10);
  let live = true;
  f.windows.get.mockImplementationOnce(async (id) => {
    live = false;
    return { id };
  });
  await f.guard.finish(() => live);
  expect(f.windows.update).not.toHaveBeenCalled();
});
