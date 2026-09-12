# Extension localization

The extension ships English (`en-US`), Simplified Chinese (`zh-CN`) and Korean
(`ko-KR`) in the `common` and `extension` namespaces. These resources cover the
popup, page overlays and extension notifications; they do not translate CLI
output or extension store metadata.

## Language selection

The extension prefers `chrome.i18n.getUILanguage()` and uses `navigator` when
that API is unavailable. Detected language tags resolve against the registered
resources: for example, `ko`, `ko-KR` and `KO-kr` select Korean. Languages without
a translation fall back to English. Chinese variants use Simplified Chinese
until a Traditional Chinese resource is registered.

A saved `chrome.storage.local.i18nextLng` preference takes precedence over the
detected language. Both restoring that preference and receiving a storage change
normalize the tag against the same resources, so a stored `ko` also selects
`ko-KR`. Matching aliases do not trigger another language change or storage write.

## Adding or updating translations

1. Add `src/locales/<locale>/common.json` and `extension.json`, preserving the
   English key structure and interpolation variables such as `{{cliProtocol}}`.
2. Register both namespaces in `src/i18n.ts`. Language normalization derives its
   mappings from this registry; no separate language list needs updating.
3. Preserve commands, line breaks and trace paths in recording instructions.
   Protocol version differences should say the connection remains available and
   an upgrade is recommended. Help prompts must make clear that the agent is
   waiting for the user to complete a step.

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
