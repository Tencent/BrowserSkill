# Browser capability evaluation corpus

This directory is a deterministic, local browser evaluation environment for BrowserSkill, DSH,
and other command-line agents. Cases, fixture pages, direct `bsk` workflows, and assertions are
data-driven and discovered automatically. Adding a case does not require editing a central switch.

[中文说明](README.zh-CN.md)

## Design goals

- Agent-neutral: prompts describe outcomes, not a particular tool schema.
- Deterministic: pages run locally and use stable markers and run-scoped events.
- Extensible: manifests, fixture modules, and workflows are auto-discovered.
- Reproducible: generated cases record a seed and derive every DOM variation from it.
- Honest verification: page-observable results, response markers, and adapter evidence are reported
  separately. Missing adapter evidence is `unverified`, never silently treated as passed.
- Privacy-safe: user badcases must be reduced to synthetic DOM and anonymized data before commit.

The corpus currently has six stable `core` cases and one seeded `matrix` case. The operation
inventory contains 28 browser operations; that count is capability coverage, not the number of
cases. Cases can grow independently and many cases may cover the same operation under different
page conditions.

## Quick start

These commands validate manifests and run unit/integration tests without launching a browser:

```sh
pnpm eval:browser validate
pnpm eval:browser list
pnpm eval:browser coverage
pnpm eval:browser:test
```

Build the repository CLI and exercise the real CLI, daemon, extension, Agent Window, and pages:

```sh
cargo build -p bsk
BSK_AUTO_UPDATE=off pnpm eval:browser smoke --suite core --bsk ./target/debug/bsk
BSK_AUTO_UPDATE=off pnpm eval:browser smoke --suite matrix --seed 4,7,14 --bsk ./target/debug/bsk
```

Every smoke case starts a fresh browser session and stops it in a `finally` cleanup path. Reports
and screenshots are written to the ignored `evals/browser/results/` directory.

`pnpm run eval:browser -- coverage` is also supported. The CLI intentionally accepts pnpm's leading
`--` separator.

## Suites and selection

| Suite | Intended use | Default execution |
| --- | --- | --- |
| `core` | Small stable acceptance set for everyday smoke and CI | Yes |
| `matrix` | Seeded DOM, timing, and layout variations | Explicit |
| `regression` | Minimized user badcases tied to an issue or fix | Explicit |
| `stress` | Higher volume or slower boundary testing | Explicit |
| `manual` | Human-dependent capabilities that cannot be deterministic | Explicit |

`smoke` and `run-agent` default to `core`, so adding a stress or regression case cannot silently
slow down existing CI. `list`, `coverage`, and `validate` inspect the full corpus by default.

```sh
pnpm eval:browser list --suite core
pnpm eval:browser list --tag form
pnpm eval:browser smoke --case form-controls
pnpm eval:browser smoke --case form-controls,generated-form
pnpm eval:browser smoke --case all
```

Filters from different dimensions are combined. Repeated/comma-separated suites or case ids are
alternatives; every requested tag must be present. `--task` remains a backward-compatible alias for
`--case`.

## Directory and discovery model

```text
evals/browser/
  cases/
    core/*.case.json
    matrix/*.case.json
    regression/<case-id>/
      <case-id>.case.json
      <case-id>.fixture.mjs
      README.md
  fixtures/pages/*.fixture.mjs
  schemas/case.schema.json
  lib/
  tests/
```

- Any `cases/**/*.case.json` file is loaded as a case manifest.
- Any `fixtures/**/*.fixture.mjs` or `cases/**/*.fixture.mjs` file is registered as a fixture.
- Manifests are ordered by suite, optional numeric `order`, then id.
- `validate` rejects duplicate case ids, duplicate routes, missing fixture routes, unknown
  operations/actions, invalid workflow variables, and adapter assertions with no evidence producer.

## Case manifest

A case owns all information needed by both an agent evaluation and direct CLI smoke:

```json
{
  "$schema": "../../schemas/case.schema.json",
  "schemaVersion": 1,
  "id": "example-case",
  "title": "Example browser behavior",
  "order": 10,
  "suite": "core",
  "tags": ["form", "keyboard"],
  "seed": 17,
  "fixture": { "startPath": "/example" },
  "prompts": { "en": "Open {url} ...", "zh-CN": "打开 {url}……" },
  "coverage": ["page.navigate", "interact.press"],
  "assertions": { "site": [], "response": [], "adapter": [] },
  "smoke": { "steps": [{ "action": "navigate" }] }
}
```

Prompt placeholders are `{url}`, `{baseUrl}`, `{runId}`, and `{seed}`. Agent adapter arguments also
support `{prompt}`, `{caseId}` / `{taskId}`, and `{variant}`.

Assertions have three independent sources:

- `site`: events emitted by the local page, such as submitted values or a history navigation.
- `response`: stable text that must appear in the agent or CLI output.
- `adapter`: facts outside page JavaScript, such as a non-empty screenshot or confirmed session
  cleanup.

The declarative smoke workflow supports navigation/history, waits, observe/snapshot/HTML,
screenshot/console/network, click/hover/fill/select/press, tabs, resize/emulation, and the manual
ownership/help operations. A step may `saveAs` its JSON result and later reference values such as
`{child.tab_id}`. A step may set `evidence` for an adapter assertion. See existing manifests for
complete examples.

## Adding a normal case

1. Add a `*.fixture.mjs` module exporting `{ id, routes, render(context) }`. It can live in shared
   `fixtures/pages/` or beside a self-contained regression case.
2. Add a `*.case.json` manifest with prompts, operation coverage, assertions, and smoke steps.
3. Make all page events run-scoped using the shared `browserEval.send(...)` client helper.
4. Run `pnpm eval:browser validate` and `pnpm eval:browser:test`.
5. Run the new case against the real local build with `smoke --case <id>`.

Prefer one behavior or failure mechanism per case. Stable synthetic markers make failures easier to
diagnose than assertions against incidental prose.

## Turning a user badcase into a regression

Create a self-contained starting point:

```sh
pnpm eval:browser scaffold reported-timeout \
  --title "Navigation settles after a late frame" \
  --source "issue-123"
```

The command creates a manifest, fixture, and reproduction notes under
`cases/regression/reported-timeout/`. Then reduce the report to the smallest relevant mechanism:

- Keep DOM structure, timing, redirects, frames, or browser state that triggers the bug.
- Replace names, account data, URLs, tokens, screenshots, and page copy with synthetic values.
- Do not commit HAR files, cookies, credentials, production HTML, or proprietary assets.
- Record the issue/PR reference, seed when relevant, expected result, and the fixing PR.
- Confirm the new case fails on the known-bad build and passes on the fixed build when practical.

## Seeded matrix cases

`generated-form` varies label association, nesting depth, hydration delay, decoy controls, field
order, and element ids while keeping the task and oracle stable. Inspect a seed without a browser:

```sh
pnpm eval:browser generate --seed user-badcase-42
pnpm eval:browser prompt generated-form --seed user-badcase-42 --run-id manual-42
pnpm eval:browser smoke --case generated-form --seed user-badcase-42
pnpm eval:browser smoke --case generated-form --seed 4,7,14
```

Repeated/comma-separated seeds run as independent results. Reports store every normalized seed, so
a failure can be replayed exactly and promoted into a named regression case if it represents a
distinct bug.

## Run any command-line agent

Copy `agents.example.json` to the ignored `agents.local.json` and adapt its command. Arguments are
passed directly to the executable without a shell.

```sh
pnpm eval:browser run-agent \
  --config evals/browser/agents.local.json \
  --agent dsh-local \
  --suite core \
  --repeat 3
```

An adapter may define `command`, `args`, `cwd`, `env`, `timeoutMs`, `variant`, free-form `metadata`,
and optional `metrics.errorPattern` / `metrics.toolCallPattern` regular expressions.

To compare 28 granular tools with domain tools, create two isolated adapter entries and run both
against the same selected cases and seeds:

```sh
pnpm eval:browser run-agent \
  --config evals/browser/agents.local.json \
  --agent dsh-granular,dsh-domain \
  --suite core \
  --repeat 10
```

Keep browser runs sequential to avoid session contention. Use fresh profiles and alternate adapter
order in larger experiments to reduce warm-cache bias.

## Reading results

```sh
pnpm eval:browser summarize evals/browser/results/*.json
```

The summary groups by adapter and variant and reports pass rate, fully verified rate, process
failures, matched error count, average tool calls, and average duration. The raw JSON retains case,
suite, tags, seed, prompt, command output, page event count, and individual oracle checks.

A healthy run has:

- no execution timeout or non-zero exit;
- no `executionError` in direct smoke;
- `verification.status` equal to `passed` (or intentionally `passed-with-unverified` for an agent
  adapter that cannot expose external evidence);
- every session cleanup assertion verified;
- no unexpected increase in errors, tool calls, or duration versus the chosen baseline.

## Development baseline

Use these lanes as commit and PR gates:

| Change | Required checks |
| --- | --- |
| Any case, fixture, oracle, or harness change | `pnpm eval:browser:check` |
| CLI, daemon, extension, DSH plugin, or browser-operation change | The check above, `cargo build -p bsk`, then real-browser `smoke --suite core` |
| DOM discovery, form interaction, timing, or waiting change | The checks above, then `smoke --suite matrix --seed 4,7,14` |
| A bug fix with a known reproduction | Add a `regression` case and run that case on the fixed build |

Before committing this harness, the complete acceptance sequence is:

```sh
pnpm eval:browser:check
cargo build -p bsk
BSK_AUTO_UPDATE=off pnpm eval:browser smoke --case all --bsk ./target/debug/bsk
BSK_AUTO_UPDATE=off pnpm eval:browser smoke --suite matrix --seed 4,7,14 --bsk ./target/debug/bsk
```

All commands must exit zero. The smoke summary must have 100% pass and fully verified rates, zero
execution failures/errors, and `bsk session list --json` must be `[]` afterward. Do not weaken an
oracle or replace a stable marker merely to make a regression pass; behavior changes should update
the case and expected baseline in the same reviewed change.

The direct smoke lane covers 25 of 28 operations. `tabs.borrow`, `tabs.return`, and
`assist.request-help` stay manual because they require a real user tab or human interaction and
would make the default suite destructive or non-deterministic.
