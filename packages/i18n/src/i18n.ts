import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import {
  bindChromeStorageLanguageSync,
  chromeUiLanguageDetector,
  getLanguageDetectionOptions,
} from "./chrome-storage-sync";
import enUSCommon from "./locales/en-US/common.json";
import enUSExtension from "./locales/en-US/extension.json";
import zhCNCommon from "./locales/zh-CN/common.json";
import zhCNExtension from "./locales/zh-CN/extension.json";

const resources = {
  "zh-CN": {
    common: zhCNCommon,
    extension: zhCNExtension,
  },
  "en-US": {
    common: enUSCommon,
    extension: enUSExtension,
  },
} as const;

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
