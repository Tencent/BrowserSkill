# browser-skill (dsh edition)

Drive the user's **real Chromium browser** (logins, cookies, Agent Window isolation)
through this plugin's `browser_*` tools. Each tool spawns `bsk <cmd> --json` — the
same engine the canonical CLI skill documents — so the workflow, judgment rules, and
safety constraints are identical.

> **Tool availability**: invoking this skill (which you just did) makes the plugin's
> `browser_*` tools available for the rest of the session — they are injected on
> successful skill load. Until then they are deliberately hidden, so do not attempt
> a browser action before loading this skill.

## Tool ↔ CLI map

The tools below are thin, structured wrappers over the bsk CLI verbs of the same
name; `session` parameters take the 4-letter session id (no `--session` flag
spelling here):

| dsh tool | bsk equivalent |
|---|---|
| `browser_session_start` / `browser_session_stop` / `browser_session_list` | `bsk session start/stop/list` |
| `browser_navigate` | `bsk navigate` |
| `browser_snapshot` / `browser_observe` | `bsk snapshot` / `bsk observe` |
| `browser_click` / `browser_fill` / `browser_press` | `bsk click` / `bsk fill` / `bsk press` |
| `browser_screenshot` | `bsk screenshot` |
| `browser_emulate` | `bsk emulate` |

(`bsk console` / `bsk network` have no tool counterpart in this plugin yet.)

Plugin-specific semantics that override or narrow the CLI rules below:

- **Owned sessions only**: this plugin sees and acts on just the sessions IT
  started via `browser_session_start`. `browser_session_list` shows only those
  (with the current marker); passing a session id created by another program
  (or person) sharing the bsk daemon is refused outright — never retry those
  with the same id.
- **Current session**: omitted `session` parameters resolve to the most
  recently started or used OWNED session. With several sessions in flight,
  pass `session` explicitly to avoid surprises.
- **Screenshots**: when the model route accepts images, `browser_screenshot`
  returns the PNG inline as an image attachment; otherwise it returns the
  saved file path.
- **`browser_emulate mobile`**: requires `width`+`height` — the bsk daemon
  refuses `--mobile` without viewport dimensions.
- **Live observation**: in the dsh Web UI, every owned session is watched by
  the floating overlay (thumbnails, action, interrupt) — observational side
  traffic is free and never steals your command turn; just keep acting.

The canonical CLI skill body follows verbatim (source of truth: `skill/SKILL.md`
in the BrowserSkill repo, mirrored by build into `crates/bsk-cli/skill/SKILL.md`).
Read `bsk <verb> --session <id>` as "the `browser_<verb>` tool with
`session: <id>`"; everything else — when to use, the stop-when-done rules, the
interaction loop, refs, sandbox rules — applies unchanged.

---
