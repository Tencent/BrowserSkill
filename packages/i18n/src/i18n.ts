import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import {
  bindChromeStorageLanguageSync,
  chromeUiLanguageDetector,
  getLanguageDetectionOptions,
} from "./chrome-storage-sync";
import deCommon from "./locales/de/common.json";
import deExtension from "./locales/de/extension.json";
import enUSCommon from "./locales/en-US/common.json";
import enUSExtension from "./locales/en-US/extension.json";
import esCommon from "./locales/es/common.json";
import esExtension from "./locales/es/extension.json";
import frCommon from "./locales/fr/common.json";
import frExtension from "./locales/fr/extension.json";
import itCommon from "./locales/it/common.json";
import itExtension from "./locales/it/extension.json";
import jaCommon from "./locales/ja/common.json";
import jaExtension from "./locales/ja/extension.json";
import koCommon from "./locales/ko/common.json";
import koExtension from "./locales/ko/extension.json";
import zhCNCommon from "./locales/zh-CN/common.json";
import zhCNExtension from "./locales/zh-CN/extension.json";
import zhTWCommon from "./locales/zh-TW/common.json";
import zhTWExtension from "./locales/zh-TW/extension.json";

const resources = {
  "en-US": {
    common: enUSCommon,
    extension: enUSExtension,
  },
  "zh-CN": {
    common: zhCNCommon,
    extension: zhCNExtension,
  },
  "zh-TW": {
    common: zhTWCommon,
    extension: zhTWExtension,
  },
  ja: {
    common: jaCommon,
    extension: jaExtension,
  },
  ko: {
    common: koCommon,
    extension: koExtension,
  },
  fr: {
    common: frCommon,
    extension: frExtension,
  },
  it: {
    common: itCommon,
    extension: itExtension,
  },
  de: {
    common: deCommon,
    extension: deExtension,
  },
  es: {
    common: esCommon,
    extension: esExtension,
  },
} as const;

const languageDetector = new LanguageDetector();
languageDetector.addDetector(chromeUiLanguageDetector);

i18n
  .use(languageDetector)
  .use(initReactI18next)
  .init({
    resources,
    // Per-language fallback chain. English is the international default, so any
    // locale we do not ship still lands on English rather than Chinese. Each
    // translated language points at its own bundle; `zh` keeps zh-CN because
    // normalizeLanguageCode already routes Traditional variants to zh-TW.
    fallbackLng: {
      en: ["en-US"],
      zh: ["zh-CN"],
      ja: ["ja"],
      ko: ["ko"],
      fr: ["fr"],
      it: ["it"],
      de: ["de"],
      es: ["es"],
      default: ["en-US"],
    },
    defaultNS: "common",
    ns: ["common", "extension"],

    interpolation: {
      escapeValue: false,
    },

    detection: getLanguageDetectionOptions(),

    react: {
      useSuspense: false,
    },
  });

bindChromeStorageLanguageSync(i18n);

export default i18n;
