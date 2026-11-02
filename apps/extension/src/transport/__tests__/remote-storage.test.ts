import { afterEach, beforeEach, expect, it, vi } from "vitest";

let values: Record<string, unknown>;
let storage: typeof import("../remote-storage");
let databaseValue: unknown;
const endpoint = { url: "wss://browser.example/extension", token: "a".repeat(43) };

beforeEach(async () => {
  vi.resetModules();
  values = {};
  databaseValue = undefined;
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async () => ({ ...values })),
        set: vi.fn(async (next) => Object.assign(values, next)),
        remove: vi.fn(async (key: string) => {
          delete values[key];
        }),
        setAccessLevel: vi.fn(async () => {
          expect(values.bsk_remote_endpoint).toBeUndefined();
        }),
      },
    },
  });
  vi.stubGlobal("indexedDB", {
    open: vi.fn(() => {
      throw new Error("storage unavailable");
    }),
  });
  storage = await import("../remote-storage");
});
afterEach(() => vi.unstubAllGlobals());

function availableDatabase() {
  vi.mocked(indexedDB.open).mockImplementation(() => {
    const request = {
      result: {
        close: vi.fn(),
        transaction: () => {
          const transaction = {
            oncomplete: () => {},
            objectStore: () => ({
              get: () => ({ result: structuredClone(databaseValue) }),
              put: (value: unknown) => {
                databaseValue = structuredClone(value);
                return {};
              },
            }),
          };
          queueMicrotask(() => transaction.oncomplete());
          return transaction;
        },
      },
      onsuccess: () => {},
    };
    queueMicrotask(() => request.onsuccess());
    return request as unknown as IDBOpenDBRequest;
  });
}

it("fresh local users do not depend on IndexedDB", async () => {
  expect(await storage.readRemoteConnection()).toBeNull();
  expect(indexedDB.open).not.toHaveBeenCalled();
});

it("explicit local mode ignores an unavailable old credential database", async () => {
  values[storage.REMOTE_CONNECTION_MODE] = "local";
  values[storage.REMOTE_CONNECTION_REVISION] = "old-revision";
  expect(await storage.readRemoteConnection()).toBeNull();
  expect(indexedDB.open).not.toHaveBeenCalled();
});

it.each([
  "remote",
  undefined,
])("configured or legacy remote state fails closed: %s", async (mode) => {
  values[storage.REMOTE_CONNECTION_MODE] = mode;
  values[storage.REMOTE_CONNECTION_REVISION] = "old-revision";
  await expect(storage.readRemoteConnection()).rejects.toThrow("storage unavailable");
});

it("a missing credential in explicit remote mode is an error", async () => {
  availableDatabase();
  values[storage.REMOTE_CONNECTION_MODE] = "remote";
  await expect(storage.readRemoteConnection()).rejects.toThrow("authorization is missing");
});

it("a failed pairing write leaves the selected local connection intact", async () => {
  values[storage.REMOTE_CONNECTION_MODE] = "local";
  await expect(storage.writeRemoteConnection(endpoint)).rejects.toThrow("storage unavailable");
  expect(values[storage.REMOTE_CONNECTION_MODE]).toBe("local");
  expect(values[storage.REMOTE_CONNECTION_REVISION]).toBeUndefined();
});

it("explicit local selection recovers from a broken remote database", async () => {
  values[storage.REMOTE_CONNECTION_MODE] = "remote";
  await storage.writeRemoteConnection(null);
  expect(await storage.readRemoteConnection()).toBeNull();
  expect(values[storage.REMOTE_CONNECTION_MODE]).toBe("local");
});

it("publishes the selected remote endpoint only after saving its private credential", async () => {
  availableDatabase();
  await storage.writeRemoteConnection(endpoint);
  expect(await storage.readRemoteConnection()).toEqual(endpoint);
  expect(JSON.stringify(values)).not.toContain(endpoint.token);
});

it("a failed legacy migration never exposes its credential to content scripts", async () => {
  values.bsk_remote_endpoint = endpoint;
  await expect(storage.readRemoteConnection()).rejects.toThrow("storage unavailable");
  expect(chrome.storage.local.setAccessLevel).not.toHaveBeenCalled();
  expect(values.bsk_remote_endpoint).toEqual(endpoint);
});

it("migrates a legacy grant before restoring ordinary settings access", async () => {
  availableDatabase();
  values.bsk_remote_endpoint = endpoint;
  expect(await storage.readRemoteConnection()).toEqual(endpoint);
  expect(values.bsk_remote_endpoint).toBeUndefined();
  expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledOnce();
});
