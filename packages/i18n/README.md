# Extension localization

The extension ships English (`en-US`), Simplified Chinese (`zh-CN`),
Traditional Chinese (`zh-TW`), Korean (`ko-KR`), Japanese (`ja-JP`), French
(`fr-FR`), Italian (`it-IT`), Spanish (`es-ES`), German (`de-DE`) and
Brazilian Portuguese (`pt-BR`) in the `common` and `extension` namespaces.
These resources cover the popup, page overlays and extension notifications;
they do not translate CLI output or extension store metadata.

Locale resources are registered automatically: dropping a
`src/locales/<locale>/{common,extension}.json` pair in place is enough for
`i18n.ts` to pick it up (see `i18n.ts`'s `import.meta.glob` scan) — no code
change is required to ship a new language.

## Language selection

The extension prefers `chrome.i18n.getUILanguage()` and uses `navigator` when
that API is unavailable. Detected language tags resolve against the registered
resources: for example, `ko`, `ko-KR` and `KO-kr` select Korean. Languages without
a translation fall back to English. Chinese script tags take precedence over
regions: `zh-Hant`, `zh-TW`, `zh-HK` and `zh-MO` select Traditional Chinese;
`zh-Hans`, bare `zh` and other Chinese regions select Simplified Chinese.
Missing Traditional Chinese strings fall back to Simplified Chinese; other
locales fall back to English. Keep every shipped resource complete rather than
relying on these fallbacks.

A saved `chrome.storage.local.i18nextLng` preference takes precedence over the
detected language. Both restoring that preference and receiving a storage change
normalize the tag against the same resources, so a stored `ko` also selects
`ko-KR`. Matching aliases do not trigger another language change or storage write.

## Adding or updating translations

1. Add `src/locales/<locale>/common.json` and `extension.json`, preserving the
   English key structure and interpolation variables such as `{{cliProtocol}}`.
2. Both namespaces are registered automatically by `src/i18n.ts`. No import or
   registry edit is needed. Update this document's shipped-language list and add
   locale-resolution coverage for the new language and relevant regional tags.
3. Preserve commands, line breaks and trace paths in recording instructions.
   Protocol version differences should say the connection remains available and
   an upgrade is recommended. Help prompts must make clear that the agent is
   waiting for the user to complete a step.
4. In profile instructions, preserve `{{command}}`, `{{toolCall}}` and the literal
   `--browser / browser`. Keep the requirements to use this profile for every new
   session, use the tool call instead of a separate CLI command in DeepSeek
   Harness, and stop and ask the user to reconnect if the instance is unavailable.

Run from the repository root:

```sh
pnpm --filter @browser-skill/i18n test
pnpm ext:test
pnpm lint
pnpm --filter @browser-skill/extension compile
pnpm ext:build
```

CI runs both test suites. The localization tests check actual registered
resources, detection, storage synchronization, key parity and interpolation
variables. The popup tests also cover Korean upgrade guidance and copied
recording instructions. When changing copy, visually check the popup and page
overlays for wrapping and clipped text in the target language.
