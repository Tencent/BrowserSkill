import { describe, expect, it, vi } from "vitest";
import {
  chromeUiLanguageDetector,
  getLanguageDetectionOptions,
  normalizeLanguageCode,
} from "../src/chrome-storage-sync";

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

    // Traditional Chinese — region subtag. `zh-TW` has no resource yet, so
    // i18next falls back to zh-CN via `fallbackLng.zh`.
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],

    // No translation shipped — returned unchanged so i18next applies the
    // `default` fallback (en-US) rather than Chinese.
    ["ja", "ja"],
    ["ja-JP", "ja-JP"],
    ["fr-FR", "fr-FR"],
    ["de-DE", "de-DE"],
  ];

  it.each(cases)("maps %s to %s", (detected, resource) => {
    expect(normalizeLanguageCode(detected)).toBe(resource);
  });

  it("is case-insensitive", () => {
    expect(normalizeLanguageCode("EN-us")).toBe("en-US");
    expect(normalizeLanguageCode("zh-hant-tw")).toBe("zh-TW");
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
    expect(convertDetectedLanguage("ja-JP")).toBe("ja-JP");
  });

  it("does not write to page-origin storage", () => {
    expect(getLanguageDetectionOptions().caches).toEqual([]);
  });
});
