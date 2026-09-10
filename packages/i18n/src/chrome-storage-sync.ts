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
 * Group resource keys by primary language subtag, so a bare `ko` can find
 * `ko-KR` without anyone maintaining a side map by hand.
 */
function buildPrimarySubtagIndex(resourceKeys: string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const key of resourceKeys) {
    const primary = key.split(/[-_]/)[0].toLowerCase();
    const bucket = index.get(primary);
    if (bucket) {
      bucket.push(key);
    } else {
      index.set(primary, [key]);
    }
  }
  return index;
}

/**
 * Chinese is the one language where a single primary subtag maps to several
 * resources, because Simplified and Traditional differ by script rather than
 * by region. Every other language resolves straight from the index.
 */
function resolveChineseVariant(parts: string[], candidates: string[]): string {
  const byRegion = (region: string): string | undefined =>
    candidates.find((key) => key.toLowerCase().endsWith(`-${region}`));

  // 1. Script subtag is the most accurate signal (zh-Hans / zh-Hant).
  if (parts.includes("hans")) {
    return byRegion("cn") ?? candidates[0];
  }
  if (parts.includes("hant")) {
    return byRegion("tw") ?? candidates[candidates.length - 1];
  }
  // 2. Fall back to the region subtag, which is what Chrome actually reports.
  //    Skip parts[0] — the primary subtag `zh` is also two characters long.
  const region = parts.slice(1).find((part) => part.length === 2);
  if (region && TRADITIONAL_CHINESE_REGIONS.has(region)) {
    return byRegion("tw") ?? candidates[0];
  }
  // 3. Bare `zh` and any other region default to Simplified.
  return byRegion("cn") ?? candidates[0];
}

/**
 * Build a normalizer driven entirely by the resource keys i18next ships, so
 * registering a new translation needs no change here.
 *
 * For a detected BCP 47 tag, in order:
 *
 * 1. it already names a resource (`ko-KR`)               → unchanged
 * 2. one resource shares its language (`ko` → `ko-KR`)   → that resource
 * 3. several do (`zh` → `zh-CN` / `zh-TW`)               → script, then region
 * 4. nothing is shipped for the language                 → unchanged
 *
 * Case 4 leaves the tag untouched so i18next applies `fallbackLng`, rather
 * than silently routing an untranslated language to the wrong bundle.
 */
export function createLanguageNormalizer(resourceKeys: string[]): (code: string) => string {
  const keySet = new Set(resourceKeys);
  const index = buildPrimarySubtagIndex(resourceKeys);

  return (code: string): string => {
    if (keySet.has(code)) {
      return code;
    }
    const parts = code.split(/[-_]/).map((part) => part.toLowerCase());
    const candidates = index.get(parts[0]);
    if (!candidates?.length) {
      return code;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }
    if (parts[0] === "zh") {
      return resolveChineseVariant(parts, candidates);
    }
    return candidates[0];
  };
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
export function getLanguageDetectionOptions(resourceKeys: string[]): {
  order: string[];
  caches: string[];
  convertDetectedLanguage: (lng: string) => string;
} {
  return {
    order: ["chromeUILanguage", "navigator"],
    caches: [],
    // Normalise the detected tag before i18next resolves it against `resources`.
    convertDetectedLanguage: createLanguageNormalizer(resourceKeys),
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
