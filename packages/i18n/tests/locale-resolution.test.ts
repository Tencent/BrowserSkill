import { describe, expect, it, vi } from "vitest";
import {
  chromeUiLanguageDetector,
  getLanguageDetectionOptions,
  normalizeLanguageCode,
} from "../src/chrome-storage-sync";
import deCommon from "../src/locales/de/common.json";
import deExtension from "../src/locales/de/extension.json";
import enUSCommon from "../src/locales/en-US/common.json";
import enUSExtension from "../src/locales/en-US/extension.json";
import esCommon from "../src/locales/es/common.json";
import esExtension from "../src/locales/es/extension.json";
import frCommon from "../src/locales/fr/common.json";
import frExtension from "../src/locales/fr/extension.json";
import itCommon from "../src/locales/it/common.json";
import itExtension from "../src/locales/it/extension.json";
import jaCommon from "../src/locales/ja/common.json";
import jaExtension from "../src/locales/ja/extension.json";
import koCommon from "../src/locales/ko/common.json";
import koExtension from "../src/locales/ko/extension.json";
import zhCNCommon from "../src/locales/zh-CN/common.json";
import zhCNExtension from "../src/locales/zh-CN/extension.json";
import zhTWCommon from "../src/locales/zh-TW/common.json";
import zhTWExtension from "../src/locales/zh-TW/extension.json";

/**
 * Locks the locale-resolution table from issue #168: the UI must follow the
 * browser language instead of falling through to Chinese for every locale
 * other than `en-US`.
 */
describe("normalizeLanguageCode", () => {
  const cases: Array<[detected: string, resource: string]> = [
    // English — every variant maps to the single en-US resource.
    ["en", "en-US"],
    ["en-US", "en-US"],
    ["en-GB", "en-US"],
    ["en-CN", "en-US"],
    ["en-AU", "en-US"],

    // Simplified Chinese — script subtag wins.
    ["zh-Hans", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-Hans-SG", "zh-CN"],

    // Simplified Chinese — region subtag.
    ["zh-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],

    // Bare `zh` defaults to Simplified.
    ["zh", "zh-CN"],

    // Traditional Chinese — script subtag wins.
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["zh-Hant-HK", "zh-TW"],

    // Traditional Chinese — region subtag.
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],

    // Japanese / Korean — bare language subtags, any region.
    ["ja", "ja"],
    ["ja-JP", "ja"],
    ["ko", "ko"],
    ["ko-KR", "ko"],

    // FIGS — bare language subtags, so regional variants share one bundle.
    ["fr", "fr"],
    ["fr-FR", "fr"],
    ["fr-CA", "fr"],
    ["it", "it"],
    ["it-IT", "it"],
    ["de", "de"],
    ["de-DE", "de"],
    ["de-AT", "de"],
    ["es", "es"],
    ["es-ES", "es"],
    ["es-MX", "es"],

    // No translation shipped — returned unchanged so i18next applies the
    // `default` fallback (en-US) rather than Chinese.
    ["pt-BR", "pt-BR"],
    ["ru-RU", "ru-RU"],
  ];

  it.each(cases)("maps %s to %s", (detected, resource) => {
    expect(normalizeLanguageCode(detected)).toBe(resource);
  });

  it("is case-insensitive", () => {
    expect(normalizeLanguageCode("EN-us")).toBe("en-US");
    expect(normalizeLanguageCode("zh-hant-tw")).toBe("zh-TW");
    expect(normalizeLanguageCode("DE-de")).toBe("de");
  });

  it("routes every locale it ships to a resource that exists", () => {
    const shipped = new Set(["en-US", "zh-CN", "zh-TW", "ja", "ko", "fr", "it", "de", "es"]);
    for (const [detected, resource] of cases) {
      if (shipped.has(resource)) {
        expect(shipped, `${detected} → ${resource}`).toContain(resource);
      }
    }
  });
});

describe("chromeUiLanguageDetector", () => {
  it("prefers chrome.i18n.getUILanguage() when available", () => {
    vi.stubGlobal("chrome", { i18n: { getUILanguage: () => "en-GB" } });
    expect(chromeUiLanguageDetector.lookup()).toBe("en-GB");
  });

  it("returns undefined outside a Chrome extension context", () => {
    vi.stubGlobal("chrome", undefined);
    expect(chromeUiLanguageDetector.lookup()).toBeUndefined();
  });

  it("returns undefined when the i18n API is unavailable", () => {
    vi.stubGlobal("chrome", {});
    expect(chromeUiLanguageDetector.lookup()).toBeUndefined();
  });
});

describe("getLanguageDetectionOptions", () => {
  it("orders the Chrome UI language ahead of navigator", () => {
    expect(getLanguageDetectionOptions().order).toEqual(["chromeUILanguage", "navigator"]);
  });

  it("normalises whatever the detectors report", () => {
    const { convertDetectedLanguage } = getLanguageDetectionOptions();
    expect(convertDetectedLanguage("en-GB")).toBe("en-US");
    expect(convertDetectedLanguage("zh-TW")).toBe("zh-TW");
    expect(convertDetectedLanguage("ja-JP")).toBe("ja");
  });

  it("does not write to page-origin storage", () => {
    expect(getLanguageDetectionOptions().caches).toEqual([]);
  });
});

/**
 * Structural checks over the shipped bundles. These use `import.meta.glob`, so
 * a newly added locale is validated automatically — the point is to catch
 * missing keys or dropped `{{placeholders}}` before they reach a release.
 */
describe("locale bundles", () => {
  const locales = {
    "en-US": { common: enUSCommon, extension: enUSExtension },
    "zh-CN": { common: zhCNCommon, extension: zhCNExtension },
    "zh-TW": { common: zhTWCommon, extension: zhTWExtension },
    ja: { common: jaCommon, extension: jaExtension },
    ko: { common: koCommon, extension: koExtension },
    fr: { common: frCommon, extension: frExtension },
    it: { common: itCommon, extension: itExtension },
    de: { common: deCommon, extension: deExtension },
    es: { common: esCommon, extension: esExtension },
  } as Record<string, { common: unknown; extension: unknown }>;

  const flatten = (value: unknown, prefix = ""): Record<string, string> => {
    const out: Record<string, string> = {};
    if (typeof value !== "object" || value === null) {
      return out;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof entry === "object" && entry !== null) {
        Object.assign(out, flatten(entry, path));
      } else {
        out[path] = String(entry);
      }
    }
    return out;
  };

  const placeholdersOf = (text: string): string[] =>
    [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();

  const EXPECTED_LOCALES = ["de", "en-US", "es", "fr", "it", "ja", "ko", "zh-CN", "zh-TW"];

  it("ships exactly the locales we expect", () => {
    expect(Object.keys(locales).sort()).toEqual(EXPECTED_LOCALES);
  });

  it.each(EXPECTED_LOCALES)("%s defines both namespaces", (locale) => {
    expect(locales[locale]?.common, `${locale}/common.json`).toBeDefined();
    expect(locales[locale]?.extension, `${locale}/extension.json`).toBeDefined();
  });

  // Merge both namespaces so keys read as `app.name`, `popup.copy`, …
  const bundleStrings = (locale: string): Record<string, string> => ({
    ...flatten(locales[locale]?.common),
    ...flatten(locales[locale]?.extension),
  });

  const reference = bundleStrings("en-US");
  const referenceKeys = Object.keys(reference).sort();

  it.each(EXPECTED_LOCALES)("%s has the same keys as en-US", (locale) => {
    expect(Object.keys(bundleStrings(locale)).sort()).toEqual(referenceKeys);
  });

  it.each(EXPECTED_LOCALES)("%s keeps the en-US placeholders intact", (locale) => {
    const strings = bundleStrings(locale);
    // A dropped {{var}} renders as a blank gap in the UI, so every key must
    // carry exactly the interpolation slots English does.
    for (const [key, english] of Object.entries(reference)) {
      expect(placeholdersOf(strings[key]), `${locale}:${key}`).toEqual(placeholdersOf(english));
    }
  });

  it.each(EXPECTED_LOCALES)("%s leaves no key empty", (locale) => {
    for (const [key, value] of Object.entries(bundleStrings(locale))) {
      expect(value.trim(), `${locale}:${key}`).not.toBe("");
    }
  });

  it("never translates the product or brand name", () => {
    for (const locale of EXPECTED_LOCALES) {
      const strings = bundleStrings(locale);
      expect(strings["app.name"], locale).toBe("browser-skill");
      expect(strings["popup.brandName"], locale).toBe("BrowserSkill");
    }
  });
});
