import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StorageItems = Record<string, unknown>;
type StorageChanges = Record<string, { newValue?: unknown }>;

async function loadI18n(browserLanguage: string | null = "ko", navigatorLanguage = "en-US") {
  const get = vi.fn<(key: string, callback: (items: StorageItems) => void) => void>();
  const set = vi.fn();
  const addListener = vi.fn<(callback: (changes: StorageChanges, area: string) => void) => void>();
  vi.stubGlobal("navigator", { language: navigatorLanguage, languages: [navigatorLanguage] });
  vi.stubGlobal("chrome", {
    i18n: browserLanguage === null ? undefined : { getUILanguage: () => browserLanguage },
    storage: { local: { get, set }, onChanged: { addListener } },
  });
  const { default: i18n } = await import("../src/i18n");
  return { i18n, set, restore: get.mock.calls[0][1], change: addListener.mock.calls[0][0] };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("shipped language detection", () => {
  it.each([
    "ko",
    "ko-KR",
    "KO-kr",
    "ko_KR",
  ])("loads both Korean namespaces for Chrome UI language %s", async (language) => {
    const { i18n } = await loadI18n(language);
    expect(i18n.resolvedLanguage).toBe("ko-KR");
    expect(i18n.t("app.description")).toContain("AI 에이전트");
    expect(i18n.t("popup.stateLabel.connected", { ns: "extension" })).toBe("연결됨");
  });

  it("uses navigator when Chrome UI language is unavailable", async () => {
    const { i18n } = await loadI18n(null, "ko");
    expect(i18n.resolvedLanguage).toBe("ko-KR");
  });

  it.each([
    ["en-GB", "en-US", "Connected"],
    ["zh-Hant", "zh-CN", "已连接"],
    ["fr-FR", "en-US", "Connected"],
  ])("preserves the fallback for %s", async (language, resolved, label) => {
    const { i18n } = await loadI18n(language);
    expect(i18n.resolvedLanguage).toBe(resolved);
    expect(i18n.t("popup.stateLabel.connected", { ns: "extension" })).toBe(label);
  });
});

describe("stored language synchronization", () => {
  it.each(["ko", "KO-kr", "ko_KR"])("restores %s as Korean", async (language) => {
    const { i18n, restore } = await loadI18n("en-US");
    restore({ i18nextLng: language });
    expect(i18n.language).toBe("ko-KR");
    expect(i18n.resolvedLanguage).toBe("ko-KR");
  });

  it("normalizes cross-context changes and avoids echo writes", async () => {
    const { i18n, change, set } = await loadI18n("en-US");
    change({ i18nextLng: { newValue: "ko" } }, "local");
    expect(i18n.resolvedLanguage).toBe("ko-KR");
    expect(set).toHaveBeenCalledExactlyOnceWith({ i18nextLng: "ko-KR" });

    change({ i18nextLng: { newValue: "ko-KR" } }, "local");
    change({ i18nextLng: { newValue: "ko" } }, "local");
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("keeps Korean when a saved alias matches the detected language", async () => {
    const { i18n, restore, set } = await loadI18n("ko-KR");
    restore({ i18nextLng: "ko" });
    expect(i18n.resolvedLanguage).toBe("ko-KR");
    expect(set).not.toHaveBeenCalled();
  });

  it("preserves a stored preference over the browser language", async () => {
    const { i18n, restore } = await loadI18n();
    restore({ i18nextLng: "en-GB" });
    expect(i18n.resolvedLanguage).toBe("en-US");
  });

  it("ignores missing or invalid values and unrelated storage changes", async () => {
    const { i18n, restore, change, set } = await loadI18n();
    restore({});
    restore({ i18nextLng: 42 });
    change({ i18nextLng: {} }, "local");
    change({ i18nextLng: { newValue: null } }, "local");
    change({ other: { newValue: "en-US" } }, "local");
    change({ i18nextLng: { newValue: "en-US" } }, "sync");
    expect(i18n.resolvedLanguage).toBe("ko-KR");
    expect(set).not.toHaveBeenCalled();
  });
});

function flattenMessages(resource: Record<string, unknown>, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(resource).flatMap(([key, value]) =>
      typeof value === "string"
        ? [[prefix + key, value]]
        : Object.entries(flattenMessages(value as Record<string, unknown>, `${prefix}${key}.`)),
    ),
  );
}

function interpolationVariables(message: string): string[] {
  return [...message.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1]).sort();
}

describe("shipped translations", () => {
  it.each([
    "common",
    "extension",
  ])("keeps %s keys and interpolation variables aligned", async (ns) => {
    const { i18n } = await loadI18n();
    const english = flattenMessages(i18n.getResourceBundle("en-US", ns));
    for (const language of Object.keys(i18n.options.resources ?? {})) {
      const translated = flattenMessages(i18n.getResourceBundle(language, ns));
      expect(Object.keys(translated).sort(), `${language}/${ns}`).toEqual(
        Object.keys(english).sort(),
      );
      for (const [key, message] of Object.entries(english)) {
        expect(translated[key].trim(), `${language}/${ns}/${key}`).not.toBe("");
        expect(interpolationVariables(translated[key]), `${language}/${ns}/${key}`).toEqual(
          interpolationVariables(message),
        );
      }
    }
  });
});
