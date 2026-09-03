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
      i18n?: {
        getUILanguage(): string;
      };
    }
  | undefined;

function getChromeLocal(): ChromeStorageLocal | undefined {
  return typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
}

/** Regions whose written Chinese defaults to Traditional. */
const TRADITIONAL_CHINESE_REGIONS = new Set(["tw", "hk", "mo"]);

/**
 * Language subtag → shipped resource key, for every locale we translate.
 *
 * Keys are bare language subtags so regional variants share one bundle:
 * `fr-CA`, `fr-BE` and `fr` all resolve to `fr`. Chinese is handled separately
 * in `normalizeLanguageCode`, because Simplified and Traditional differ by
 * script rather than by region.
 */
const RESOURCE_BY_LANGUAGE: Record<string, string> = {
  en: "en-US",
  ja: "ja",
  ko: "ko",
  fr: "fr",
  it: "it",
  de: "de",
  es: "es",
};

/**
 * Normalize a BCP 47 language tag to one of the shipped resource keys.
 *
 * | detected tag             | resource | rule               |
 * | ------------------------ | -------- | ------------------ |
 * | `en`, `en-GB`, `en-CN`   | `en-US`  | language subtag    |
 * | `zh-Hans*`               | `zh-CN`  | script subtag wins |
 * | `zh-Hant*`               | `zh-TW`  | script subtag wins |
 * | `zh-CN`, `zh-SG`, `zh`   | `zh-CN`  | region / default   |
 * | `zh-TW`, `zh-HK`, `zh-MO`| `zh-TW`  | region subtag      |
 * | `ja*`, `ko*`, `fr*`      | `ja`, `ko`, `fr` | language subtag |
 * | `it*`, `de*`, `es*`      | `it`, `de`, `es` | language subtag |
 * | anything else            | unchanged| → `fallbackLng`    |
 *
 * Simplified vs Traditional is decided by the script subtag (`Hans` / `Hant`)
 * when present, then by the region subtag — Chrome reports `zh-CN` / `zh-TW`
 * rather than script subtags in practice.
 */
export function normalizeLanguageCode(code: string): string {
  const parts = code.split(/[-_]/).map((part) => part.toLowerCase());
  const primary = parts[0];

  // Chinese needs script-level resolution; every other locale maps by subtag.
  if (primary === "zh") {
    // 1. Script subtag is the most accurate signal (zh-Hans / zh-Hant).
    if (parts.includes("hans")) {
      return "zh-CN";
    }
    if (parts.includes("hant")) {
      return "zh-TW";
    }
    // 2. Fall back to the region subtag, which is what Chrome actually reports.
    //    Skip parts[0] — the primary subtag `zh` is also two characters long.
    const region = parts.slice(1).find((part) => part.length === 2);
    if (region && TRADITIONAL_CHINESE_REGIONS.has(region)) {
      return "zh-TW";
    }
    // 3. Bare `zh` and any other region default to Simplified.
    return "zh-CN";
  }

  // No translation shipped: leave untouched so i18next applies `fallbackLng`.
  return RESOURCE_BY_LANGUAGE[primary] ?? code;
}

/**
 * i18next detector that prefers `chrome.i18n.getUILanguage()`, Chrome's
 * authoritative source for the extension UI language. The popup runs on a
 * `chrome-extension://` origin where `navigator.language` can disagree with it.
 */
export const chromeUiLanguageDetector = {
  name: "chromeUILanguage",
  lookup(): string | undefined {
    if (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage) {
      return chrome.i18n.getUILanguage();
    }
    return undefined;
  },
};

/** Avoid page-origin localStorage; use extension storage + navigator only. */
export function getLanguageDetectionOptions(): {
  order: string[];
  caches: string[];
  convertDetectedLanguage: (lng: string) => string;
} {
  return {
    order: ["chromeUILanguage", "navigator"],
    caches: [],
    // Normalise the detected tag before i18next resolves it against `resources`.
    convertDetectedLanguage: (lng: string) => normalizeLanguageCode(lng),
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
