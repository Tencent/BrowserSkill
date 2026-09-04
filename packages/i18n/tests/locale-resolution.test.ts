import { describe, expect, it, vi } from "vitest";
import {
  chromeUiLanguageDetector,
  createLanguageNormalizer,
  getLanguageDetectionOptions,
} from "../src/chrome-storage-sync";

/** What `packages/i18n` ships today — kept in sync with `resources` in i18n.ts. */
const SHIPPED_RESOURCE_KEYS = ["zh-CN", "en-US"];

/**
 * Locks the locale-resolution table from issue #168: the UI must follow the
 * browser language instead of falling through to Chinese for every locale
 * other than `en-US`.
 */
describe("createLanguageNormalizer", () => {
  const normalize = createLanguageNormalizer(SHIPPED_RESOURCE_KEYS);

  const cases: Array<[detected: string, resource: string]> = [
    // English — every variant maps to the single en-US resource.
    ["en", "en-US"],
    ["en-US", "en-US"],
    ["en-GB", "en-US"],
    ["en-CN", "en-US"],
    ["en-AU", "en-US"],

    // Chinese — only `zh-CN` ships today, so every variant resolves to it
    // directly rather than leaking into the fallback chain. Traditional picks
    // up `zh-TW` automatically once that bundle is registered (see below).
    ["zh", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-Hans-SG", "zh-CN"],
    ["zh-TW", "zh-CN"],
    ["zh-HK", "zh-CN"],
    ["zh-MO", "zh-CN"],
    ["zh-Hant", "zh-CN"],
    ["zh-Hant-TW", "zh-CN"],
    ["zh-Hant-HK", "zh-CN"],

    // No translation shipped — returned unchanged so i18next applies the
    // `default` fallback (en-US) rather than Chinese.
    ["ja", "ja"],
    ["ja-JP", "ja-JP"],
    ["fr-FR", "fr-FR"],
    ["de-DE", "de-DE"],
  ];

  it.each(cases)("maps %s to %s", (detected, resource) => {
    expect(normalize(detected)).toBe(resource);
  });

  it("is case-insensitive", () => {
    expect(normalize("EN-us")).toBe("en-US");
    expect(normalize("zh-hant-tw")).toBe("zh-CN");
  });
});

/**
 * The point of the factory: supporting a new language means registering its
 * bundle in `resources` — never touching the normalizer.
 */
describe("createLanguageNormalizer extensibility", () => {
  it("auto-resolves a newly registered language", () => {
    const normalize = createLanguageNormalizer(["en-US", "zh-CN", "ko-KR"]);
    expect(normalize("ko")).toBe("ko-KR");
    expect(normalize("ko-KR")).toBe("ko-KR");
  });

  it("disambiguates zh once a Traditional bundle ships", () => {
    const normalize = createLanguageNormalizer(["en-US", "zh-CN", "zh-TW"]);
    expect(normalize("zh-Hant")).toBe("zh-TW");
    expect(normalize("zh-Hant-TW")).toBe("zh-TW");
    expect(normalize("zh-TW")).toBe("zh-TW");
    expect(normalize("zh-HK")).toBe("zh-TW");
    expect(normalize("zh-MO")).toBe("zh-TW");
    expect(normalize("zh-Hans")).toBe("zh-CN");
    expect(normalize("zh-CN")).toBe("zh-CN");
    expect(normalize("zh")).toBe("zh-CN");
  });

  it("leaves unregistered languages to fallbackLng", () => {
    const normalize = createLanguageNormalizer(["en-US", "zh-CN"]);
    expect(normalize("pt-BR")).toBe("pt-BR");
    expect(normalize("ru")).toBe("ru");
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
    expect(getLanguageDetectionOptions(SHIPPED_RESOURCE_KEYS).order).toEqual([
      "chromeUILanguage",
      "navigator",
    ]);
  });

  it("normalises whatever the detectors report", () => {
    const { convertDetectedLanguage } = getLanguageDetectionOptions(SHIPPED_RESOURCE_KEYS);
    expect(convertDetectedLanguage("en-GB")).toBe("en-US");
    expect(convertDetectedLanguage("zh-TW")).toBe("zh-CN");
    expect(convertDetectedLanguage("ja-JP")).toBe("ja-JP");
  });

  it("does not write to page-origin storage", () => {
    expect(getLanguageDetectionOptions(SHIPPED_RESOURCE_KEYS).caches).toEqual([]);
  });
});
