import { describe, expect, it, vi } from "vitest";
import {
  getConnectionEnabled,
  getLabel,
  getOrCreateInstanceId,
  STORAGE_KEYS,
  setConnectionEnabled,
  setLabel,
} from "../instance-id";

function fakeStorage(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  return {
    store,
    backend: {
      get: vi.fn(async (keys: string | string[]) => {
        const result: Record<string, unknown> = {};
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) if (k in store) result[k] = store[k];
        return result;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      }),
    },
  };
}

describe("instance-id", () => {
  it("generates a new 8-char hex id when storage is empty and persists it", async () => {
    const { store, backend } = fakeStorage();
    const id = await getOrCreateInstanceId(backend);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(store[STORAGE_KEYS.INSTANCE_ID]).toBe(id);
    expect(backend.set).toHaveBeenCalledOnce();
  });

  it("returns the persisted short id on subsequent calls", async () => {
    const existing = "a7f32e1c";
    const { backend } = fakeStorage({ [STORAGE_KEYS.INSTANCE_ID]: existing });
    const id = await getOrCreateInstanceId(backend);
    expect(id).toBe(existing);
    expect(backend.set).not.toHaveBeenCalled();
  });

  it("replaces legacy UUID storage with a short id", async () => {
    const legacy = "abcdef01-2345-4678-89ab-cdef01234567";
    const { backend, store } = fakeStorage({ [STORAGE_KEYS.INSTANCE_ID]: legacy });
    const id = await getOrCreateInstanceId(backend);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(id).not.toBe(legacy);
    expect(store[STORAGE_KEYS.INSTANCE_ID]).toBe(id);
    expect(backend.set).toHaveBeenCalledOnce();
  });

  it("treats non-string stored values as missing", async () => {
    const { backend, store } = fakeStorage({ [STORAGE_KEYS.INSTANCE_ID]: 42 });
    const id = await getOrCreateInstanceId(backend);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(store[STORAGE_KEYS.INSTANCE_ID]).toBe(id);
  });

  it("getLabel returns empty string when label is unset", async () => {
    const { backend } = fakeStorage();
    expect(await getLabel(backend)).toBe("");
  });

  it("setLabel persists the value retrievable by getLabel", async () => {
    const { backend, store } = fakeStorage();
    await setLabel("Personal Chrome", backend);
    expect(store[STORAGE_KEYS.LABEL]).toBe("Personal Chrome");
    expect(await getLabel(backend)).toBe("Personal Chrome");
  });

  it("getConnectionEnabled returns true when storage is empty", async () => {
    const { backend } = fakeStorage();
    expect(await getConnectionEnabled(backend)).toBe(true);
  });

  it("getConnectionEnabled returns persisted boolean values", async () => {
    const { backend } = fakeStorage({ [STORAGE_KEYS.CONNECTION_ENABLED]: false });
    expect(await getConnectionEnabled(backend)).toBe(false);
  });

  it("getConnectionEnabled treats non-boolean stored values as enabled", async () => {
    const { backend } = fakeStorage({ [STORAGE_KEYS.CONNECTION_ENABLED]: "false" });
    expect(await getConnectionEnabled(backend)).toBe(true);
  });

  it("setConnectionEnabled persists the value retrievable by getConnectionEnabled", async () => {
    const { backend, store } = fakeStorage();
    await setConnectionEnabled(false, backend);
    expect(store[STORAGE_KEYS.CONNECTION_ENABLED]).toBe(false);
    expect(await getConnectionEnabled(backend)).toBe(false);
  });
});
