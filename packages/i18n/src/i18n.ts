import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import { bindChromeStorageLanguageSync, getLanguageDetectionOptions } from "./chrome-storage-sync";
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

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "zh-CN",
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
