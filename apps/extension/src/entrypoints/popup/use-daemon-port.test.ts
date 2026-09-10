import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "@/lib/instance-id";
import { DEFAULT_DAEMON_PORT } from "@/transport/daemon-endpoint";
import { useDaemonPort } from "./use-daemon-port";

const key = STORAGE_KEYS.DAEMON_PORT;
let read: (items: Record<string, unknown>) => void;
let changed: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
let runtime: { lastError?: { message: string } };
let writes: Array<{ items: Record<string, unknown>; done: () => void }>;

beforeEach(() => {
  runtime = {};
  writes = [];
  vi.stubGlobal("chrome", {
    runtime,
    storage: {
      local: {
        get: (_: string, cb: typeof read) => {
          read = cb;
        },
        set: (items: Record<string, unknown>, done: () => void) => {
          writes.push({ items, done });
        },
      },
      onChanged: {
        addListener: (cb: typeof changed) => {
          changed = cb;
        },
        removeListener: vi.fn(),
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function load(port = 53200) {
  await act(async () => read({ [key]: port }));
}

describe("useDaemonPort", () => {
  it("never writes an unread preference on edit, submit, blur, pagehide or unmount", async () => {
    const hook = renderHook(() => useDaemonPort());
    act(() => hook.result.current.setDraft("53300"));
    await act(async () => {
      await hook.result.current.commit();
    });
    act(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(hook.result.current.loaded).toBe(false);
    expect(writes).toHaveLength(0);
    hook.unmount();
    await load();
    expect(writes).toHaveLength(0);
  });

  it("retains the latest storage change when initial reading finishes later", async () => {
    const hook = renderHook(() => useDaemonPort());
    act(() => changed({ [key]: { newValue: 53300 } }, "local"));
    await load();
    expect(hook.result.current.draft).toBe("53300");
    expect(writes).toHaveLength(0);
  });

  it("does not overwrite a local edit with a storage notification", async () => {
    const hook = renderHook(() => useDaemonPort());
    await load();
    act(() => hook.result.current.setDraft("53400"));
    act(() => changed({ [key]: { newValue: 53300 } }, "local"));
    expect(hook.result.current.draft).toBe("53400");
    expect(hook.result.current.dirty).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(writes).toHaveLength(0);
  });

  it("follows subsequent storage changes once an edit matches the saved value", async () => {
    const hook = renderHook(() => useDaemonPort());
    await load();
    act(() => hook.result.current.setDraft("53300"));
    act(() => changed({ [key]: { newValue: 53300 } }, "local"));
    expect(hook.result.current.dirty).toBe(false);
    act(() => changed({ [key]: { newValue: 53400 } }, "local"));
    expect(hook.result.current.draft).toBe("53400");
    expect(hook.result.current.dirty).toBe(false);
  });

  it("normalizes an unchanged value without writing or reconnecting", async () => {
    const hook = renderHook(() => useDaemonPort());
    await load();
    act(() => hook.result.current.setDraft(" 053200 "));
    await act(async () => {
      await hook.result.current.commit();
    });
    expect(writes).toHaveLength(0);
    expect(hook.result.current.draft).toBe("53200");
    expect(hook.result.current.dirty).toBe(false);
  });

  it.each(["abc", "53200abc", "1.5", "0", "65536"])("rejects %s without writing", async (value) => {
    const hook = renderHook(() => useDaemonPort());
    await load();
    act(() => hook.result.current.setDraft(value));
    await act(async () => {
      await hook.result.current.commit();
    });
    expect(hook.result.current.invalid).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it("blocks duplicate saves and edits until an explicit default reset is saved", async () => {
    const hook = renderHook(() => useDaemonPort());
    await load();
    act(() => hook.result.current.setDraft(""));
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.commit();
    });
    expect(hook.result.current.saving).toBe(true);
    act(() => hook.result.current.setDraft("53400"));
    await act(async () => {
      await hook.result.current.commit();
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].items).toEqual({ [key]: DEFAULT_DAEMON_PORT });
    await act(async () => {
      writes[0].done();
      await saving;
    });
    expect(hook.result.current.draft).toBe(String(DEFAULT_DAEMON_PORT));
    expect(hook.result.current.dirty).toBe(false);
    expect(hook.result.current.saving).toBe(false);
  });

  it("retains the draft after a failed save and allows retry", async () => {
    const hook = renderHook(() => useDaemonPort());
    await load();
    act(() => hook.result.current.setDraft("53300"));
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.commit();
    });
    await act(async () => {
      runtime.lastError = { message: "write failed" };
      writes[0].done();
      delete runtime.lastError;
      await saving;
    });
    expect(hook.result.current.error).toBe("write");
    expect(hook.result.current.draft).toBe("53300");
    expect(hook.result.current.dirty).toBe(true);
    act(() => {
      saving = hook.result.current.commit();
    });
    await act(async () => {
      writes[1].done();
      await saving;
    });
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.dirty).toBe(false);
  });

  it("shows read failure without interpreting the empty draft as a reset", async () => {
    const hook = renderHook(() => useDaemonPort());
    await act(async () => {
      runtime.lastError = { message: "read failed" };
      read({});
      delete runtime.lastError;
    });
    expect(hook.result.current.error).toBe("read");
    expect(hook.result.current.loaded).toBe(false);
    await act(async () => {
      await hook.result.current.commit();
    });
    expect(writes).toHaveLength(0);
  });

  it("does not replace newer persisted state with a late write completion", async () => {
    const hook = renderHook(() => useDaemonPort());
    await load();
    act(() => hook.result.current.setDraft("53300"));
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.commit();
    });
    act(() => changed({ [key]: { newValue: 53400 } }, "local"));
    await act(async () => {
      writes[0].done();
      await saving;
    });
    expect(hook.result.current.draft).toBe("53400");
    expect(hook.result.current.dirty).toBe(false);
  });
});
