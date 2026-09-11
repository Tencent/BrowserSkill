import { afterEach, expect, it, vi } from "vitest";
import { watchDaemonConnection } from "../daemon-connection-preference";

afterEach(() => vi.unstubAllGlobals());
it("a late startup read cannot overwrite newer credentials", async () => {
  let changed: (values: unknown, area: string) => void = () => {};
  const resolvers: Array<(value: unknown) => void> = [];
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: () => new Promise((resolve) => resolvers.push(resolve)) },
      onChanged: {
        addListener: (fn: typeof changed) => {
          changed = fn;
        },
        removeListener: vi.fn(),
      },
    },
  });
  const callback = vi.fn();
  const watch = watchDaemonConnection(callback);
  changed({ bsk_remote_endpoint: {} }, "local");
  const remote = { url: "wss://example.com/bsk", token: "a".repeat(43) };
  resolvers[1]({ bsk_remote_endpoint: remote });
  await Promise.resolve();
  resolvers[0]({ bsk_daemon_port: 1234 });
  await watch.ready;
  expect(callback).toHaveBeenCalledTimes(1);
  expect(callback).toHaveBeenCalledWith(remote.url, remote);
  watch.dispose();
});
it("disposal prevents pending reads from configuring a connection", async () => {
  let finish: (value: unknown) => void = () => {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  const callback = vi.fn();
  const watch = watchDaemonConnection(callback);
  watch.dispose();
  finish({});
  await watch.ready;
  expect(callback).not.toHaveBeenCalled();
});
