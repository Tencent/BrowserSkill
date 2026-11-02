import type { Resource, ResourceLanguage } from "i18next";
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import {
  bindChromeStorageLanguageSync,
  chromeUiLanguageDetector,
  getLanguageDetectionOptions,
} from "./chrome-storage-sync";

/**
 * Every `locales/<locale>/<namespace>.json` is registered automatically, so
 * shipping a new language means adding its resource files — no code change.
 */
const localeModules = import.meta.glob<ResourceLanguage>("./locales/*/*.json", {
  eager: true,
  import: "default",
});

function buildResources(): Resource {
  const resources: Resource = {};
  for (const [path, messages] of Object.entries(localeModules)) {
    const match = /^\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (!match) {
      continue;
    }
    const [, locale, namespace] = match;
    const namespaces = resources[locale] ?? {};
    namespaces[namespace] = messages;
    resources[locale] = namespaces;
  }
  return resources;
}

// Sort the keys: multi-candidate locale resolution reads the order of
// `Object.keys(resources)`, so it must not depend on filesystem enumeration.
const resources = Object.fromEntries(
  Object.entries(buildResources()).sort(([left], [right]) => left.localeCompare(right)),
);

const languageDetector = new LanguageDetector();
languageDetector.addDetector(chromeUiLanguageDetector);

// Drive locale normalisation off the keys we actually ship, so registering a
// translation is the only step needed to support a new language.
const resourceKeys = Object.keys(resources);

i18n
  .use(languageDetector)
  .use(initReactI18next)
  .init({
    resources,
    // English is the international default; Chinese users still get Chinese.
    // `zh` → zh-CN also covers zh-TW/zh-HK until a Traditional resource exists.
    fallbackLng: { en: ["en-US"], zh: ["zh-CN"], default: ["en-US"] },
    defaultNS: "common",
    ns: ["common", "extension"],

    interpolation: {
      escapeValue: false,
    },

    detection: getLanguageDetectionOptions(resourceKeys),

    react: {
      useSuspense: false,
    },
  });

bindChromeStorageLanguageSync(i18n);

export default i18n;
