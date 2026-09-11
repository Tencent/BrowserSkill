import { useTranslation } from "@browser-skill/i18n/react";
import { useEffect, useState } from "react";
import { type InteractionPreferences, interactionPreferences } from "@/lib/interaction-preferences";
import { SettingInfo } from "./setting-info";
import { Switch } from "./switch";

export function InteractionSettings() {
  const { t } = useTranslation("extension");
  const [preferences, setPreferences] = useState(interactionPreferences.get());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"read" | "write" | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = interactionPreferences.subscribe(setPreferences);
    void interactionPreferences.ready().then(
      () => {
        if (active) setLoaded(true);
      },
      () => {
        if (active) setError("read");
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function update(key: keyof InteractionPreferences, value: boolean) {
    setSaving(true);
    setError(null);
    try {
      await interactionPreferences.set({ ...interactionPreferences.get(), [key]: value });
    } catch {
      setError("write");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="space-y-3 rounded-xl border border-border/80 bg-card/60 px-3 py-2.5"
      data-slot="popup-interaction-settings"
    >
      <h2 className="text-sm font-medium">{t("popup.interaction.title")}</h2>
      {(["confirmTabBorrow", "requestHelpEnabled"] as const).map((key) => (
        <div className="relative flex items-center justify-between gap-2" key={key}>
          <span className="flex min-w-0 items-center gap-1">
            <label className="text-sm font-medium" htmlFor={`interaction-${key}`}>
              {t(`popup.interaction.${key}`)}
            </label>
            <SettingInfo label={t(`popup.interaction.${key}InfoLabel`)}>
              {t(`popup.interaction.${key}Hint`)}
              <span className="mt-1 block">{t("popup.interaction.scope")}</span>
            </SettingInfo>
          </span>
          <Switch
            id={`interaction-${key}`}
            checked={preferences[key]}
            disabled={!loaded || saving}
            onCheckedChange={(value) => void update(key, value)}
            aria-label={t(`popup.interaction.${key}`)}
          />
        </div>
      ))}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {t(`popup.interaction.${error}Failed`)}
        </p>
      )}
    </section>
  );
}
