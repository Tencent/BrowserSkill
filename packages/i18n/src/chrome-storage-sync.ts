import type { i18n as I18nType } from "i18next";

const STORAGE_KEY = "i18nextLng";

interface ChromeStorageLocal {
  get(
    keys: string | string[] | Record<string, unknown>,
    callback: (items: Record<string, unknown>) => void,
  ): void;
  set(items: Record<string, unknown>, callback?: () => void): void;
}

interface StorageChange {
  newValue?: unknown;
}

declare const chrome:
  | {
      storage?: {
        local?: ChromeStorageLocal;
        onChanged?: {
          addListener: (
            callback: (changes: Record<string, StorageChange>, areaName: string) => void,
          ) => void;
        };
      };
    }
  | undefined;

function getChromeLocal(): ChromeStorageLocal | undefined {
  return typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
}

/** Avoid page-origin localStorage; use extension storage + navigator only. */
export function getLanguageDetectionOptions(): {
  order: string[];
  caches: string[];
} {
  return {
    order: ["navigator"],
    caches: [],
  };
}

/** Load persisted locale and keep popup/content scripts in sync via chrome.storage. */
export function bindChromeStorageLanguageSync(i18n: I18nType): void {
  const storage = getChromeLocal();
  if (!storage) {
    return;
  }

  storage.get(STORAGE_KEY, (items) => {
    const saved = items[STORAGE_KEY];
    if (typeof saved === "string" && saved !== i18n.language) {
      void i18n.changeLanguage(saved);
    }
  });

  i18n.on("languageChanged", (lng) => {
    storage.set({ [STORAGE_KEY]: lng });
  });

  chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !(STORAGE_KEY in changes)) {
      return;
    }
    const next = changes[STORAGE_KEY]?.newValue;
    if (typeof next === "string" && next !== i18n.language) {
      void i18n.changeLanguage(next);
    }
  });
}
