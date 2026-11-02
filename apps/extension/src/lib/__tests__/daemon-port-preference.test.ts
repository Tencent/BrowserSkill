import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DAEMON_PORT } from "@/transport/daemon-endpoint";
import { watchDaemonPort } from "../daemon-port-preference";
import { STORAGE_KEYS } from "../instance-id";

function storage() {
  let read!: (items: Record<string, unknown>) => void;
  let changed!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
  const removeListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {},
    storage: {
      local: {
        get: (_: string, cb: typeof read) => {
          read = cb;
        },
      },
      onChanged: {
        addListener: (cb: typeof changed) => {
          changed = cb;
        },
        removeListener,
      },
    },
  });
  return {
    read: (value: unknown) => read({ [STORAGE_KEYS.DAEMON_PORT]: value }),
    change: (value: unknown, area = "local") =>
      changed({ [STORAGE_KEYS.DAEMON_PORT]: { newValue: value } }, area),
    removeListener,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("watchDaemonPort", () => {
  it("uses the latest change instead of a late initial read", async () => {
    const store = storage();
    const onPort = vi.fn();
    const watch = watchDaemonPort(onPort);
    store.change(53200);
    store.change(53300);
    store.read(52800);
    await watch.ready;
    expect(onPort.mock.calls).toEqual([[53200], [53300]]);
    watch.dispose();
    expect(store.removeListener).toHaveBeenCalledOnce();
  });

  it("normalizes removed, malformed and numeric-string values consistently", async () => {
    const store = storage();
    const onPort = vi.fn();
    const watch = watchDaemonPort(onPort);
    store.read("53200");
    await watch.ready;
    store.change(53300, "sync");
    store.change(undefined);
    store.change("53200abc");
    store.change("53400");
    expect(onPort.mock.calls).toEqual([
      [53200],
      [DEFAULT_DAEMON_PORT],
      [DEFAULT_DAEMON_PORT],
      [53400],
    ]);
    watch.dispose();
  });

  it("does not deliver an initial read after disposal", async () => {
    const store = storage();
    const onPort = vi.fn();
    const watch = watchDaemonPort(onPort);
    watch.dispose();
    store.read(53200);
    await watch.ready;
    expect(onPort).not.toHaveBeenCalled();
  });
});
