import "i18next";
import type zhCNCommon from "./locales/zh-CN/common.json";
import type zhCNExtension from "./locales/zh-CN/extension.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof zhCNCommon;
      extension: typeof zhCNExtension;
    };
  }
}
