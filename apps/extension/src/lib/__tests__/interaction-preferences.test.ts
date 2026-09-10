import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INTERACTION_PREFERENCES,
  INTERACTION_STORAGE_KEY,
  InteractionPreferenceStore,
  interactionPolicy,
  normalizeInteractionPreferences,
} from "../interaction-preferences";

describe("interaction preferences", () => {
  let listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      storage: {
        onChanged: {
          addListener: (callback: typeof listener) => {
            listener = callback;
          },
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps both prompts enabled unless explicitly disabled", () => {
    for (const value of [
      null,
      undefined,
      {},
      { confirmTabBorrow: 0, requestHelpEnabled: "false" },
    ]) {
      expect(normalizeInteractionPreferences(value)).toEqual(DEFAULT_INTERACTION_PREFERENCES);
    }
    expect(normalizeInteractionPreferences({ confirmTabBorrow: false })).toEqual({
      confirmTabBorrow: false,
      requestHelpEnabled: true,
    });
  });

  it("a storage change wins over a stale initial read", async () => {
    let read!: (items: Record<string, unknown>) => void;
    const store = new InteractionPreferenceStore({
      get: () =>
        new Promise((resolve) => {
          read = resolve;
        }),
      set: vi.fn(),
    });
    const ready = store.ready();
    listener({ [INTERACTION_STORAGE_KEY]: { newValue: { confirmTabBorrow: false } } }, "local");
    read({ [INTERACTION_STORAGE_KEY]: DEFAULT_INTERACTION_PREFERENCES });
    await ready;
    expect(store.get().confirmTabBorrow).toBe(false);
  });

  it("a failed save preserves the previous policy", async () => {
    const store = new InteractionPreferenceStore({
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    await expect(store.set({ confirmTabBorrow: false, requestHelpEnabled: false })).rejects.toThrow(
      "disk full",
    );
    expect(store.get()).toEqual(DEFAULT_INTERACTION_PREFERENCES);
  });

  it("does not overwrite a newer storage event when a write finishes late", async () => {
    let written!: () => void;
    const store = new InteractionPreferenceStore({
      get: vi.fn().mockResolvedValue({}),
      set: () =>
        new Promise((resolve) => {
          written = resolve;
        }),
    });
    await store.ready();
    const pending = store.set({ confirmTabBorrow: false, requestHelpEnabled: true });
    await vi.waitFor(() => expect(written).toBeDefined());
    listener(
      {
        [INTERACTION_STORAGE_KEY]: {
          newValue: { confirmTabBorrow: true, requestHelpEnabled: false },
        },
      },
      "local",
    );
    written();
    await pending;
    expect(store.get()).toEqual({ confirmTabBorrow: true, requestHelpEnabled: false });
  });

  it("unattended policy is independent of ordinary sessions and persisted preferences", () => {
    const preferences = { ...DEFAULT_INTERACTION_PREFERENCES };
    expect(interactionPolicy(preferences, true)).toEqual({
      borrow_confirmation: "never",
      request_help: "disabled",
    });
    expect(interactionPolicy(preferences)).toEqual({
      borrow_confirmation: "always",
      request_help: "enabled",
    });
    expect(preferences).toEqual(DEFAULT_INTERACTION_PREFERENCES);
  });
});
