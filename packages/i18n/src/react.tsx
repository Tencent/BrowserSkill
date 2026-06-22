import type { KeyPrefix } from "i18next";
import {
  type FallbackNs,
  I18nextProvider,
  Trans as TransBase,
  type UseTranslationOptions,
  useTranslation as useTranslationBase,
} from "react-i18next";
import "./types";

type BrowserSkillNamespace = "common" | "extension";

/** Re-export with `const Ns` so `t()` keys are scoped to the namespace you pass. */
export function useTranslation<
  const Ns extends BrowserSkillNamespace | undefined = undefined,
  const KPrefix extends KeyPrefix<FallbackNs<Ns>> = undefined,
>(ns?: Ns, options?: UseTranslationOptions<KPrefix>) {
  return useTranslationBase(ns, options);
}

export const Trans = TransBase;
export { I18nextProvider };
