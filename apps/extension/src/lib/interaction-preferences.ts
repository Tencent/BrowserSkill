import type { InteractionPolicy } from "@/transport/types";
import { defaultStorage, type StorageBackend } from "./instance-id";

export interface InteractionPreferences {
  confirmTabBorrow: boolean;
  requestHelpEnabled: boolean;
}

export const INTERACTION_STORAGE_KEY = "bsk_interaction_preferences";
export const DEFAULT_INTERACTION_PREFERENCES: InteractionPreferences = {
  confirmTabBorrow: true,
  requestHelpEnabled: true,
};

export function normalizeInteractionPreferences(value: unknown): InteractionPreferences {
  const prefs = value as Partial<InteractionPreferences> | null | undefined;
  return {
    confirmTabBorrow: prefs?.confirmTabBorrow !== false,
    requestHelpEnabled: prefs?.requestHelpEnabled !== false,
  };
}

export function interactionPolicy(
  preferences: InteractionPreferences,
  unattended = false,
): InteractionPolicy {
  return {
    borrow_confirmation: unattended || !preferences.confirmTabBorrow ? "never" : "always",
    request_help: unattended || !preferences.requestHelpEnabled ? "disabled" : "enabled",
  };
}

/** Shared by the popup and background; subscribe before reading to avoid stale initialization. */
export class InteractionPreferenceStore {
  private value = { ...DEFAULT_INTERACTION_PREFERENCES };
  private readonly listeners = new Set<(value: InteractionPreferences) => void>();
  private initialization?: Promise<void>;
  private listening = false;
  private loaded = false;
  private revision = 0;

  constructor(private readonly storage: StorageBackend = defaultStorage()) {}

  get(): InteractionPreferences {
    return { ...this.value };
  }

  subscribe(listener: (value: InteractionPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(value: unknown): void {
    const next = normalizeInteractionPreferences(value);
    this.loaded = true;
    this.revision += 1;
    if (
      next.confirmTabBorrow === this.value.confirmTabBorrow &&
      next.requestHelpEnabled === this.value.requestHelpEnabled
    )
      return;
    this.value = next;
    for (const listener of this.listeners) listener(this.get());
  }

  async ready(): Promise<void> {
    if (this.loaded) return;
    if (this.initialization) return this.initialization;
    if (!this.listening) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes[INTERACTION_STORAGE_KEY]) return;
        this.publish(changes[INTERACTION_STORAGE_KEY].newValue);
      });
      this.listening = true;
    }
    const revision = this.revision;
    this.initialization = this.storage
      .get(INTERACTION_STORAGE_KEY)
      .then(
        (items) => {
          if (revision === this.revision) this.publish(items[INTERACTION_STORAGE_KEY]);
        },
        (error) => {
          if (!this.loaded) throw error;
        },
      )
      .finally(() => {
        // A failed initial read must not poison future requests or add another listener.
        this.initialization = undefined;
      });
    return this.initialization;
  }

  /** Runtime reads preserve the current policy on failure; popup reads and writes remain strict. */
  async readyOrFallback(): Promise<void> {
    try {
      await this.ready();
    } catch (error) {
      console.warn(
        "[bsk] interaction preferences unavailable; retaining the current policy",
        error,
      );
    }
  }

  async set(value: InteractionPreferences): Promise<void> {
    await this.ready();
    const normalized = normalizeInteractionPreferences(value);
    const revision = this.revision;
    await this.storage.set({ [INTERACTION_STORAGE_KEY]: normalized });
    if (revision === this.revision) this.publish(normalized);
  }
}

export const interactionPreferences = new InteractionPreferenceStore();
