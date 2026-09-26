# Changelog

All notable changes to BrowserSkill will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

Starting from 0.2.0, CLI / Extension / DSH Plugin share the same version number.

## [Unreleased]

### Fixed

- A failed auto-update no longer leaves the browser disconnected
  ([#336](https://github.com/Tencent/BrowserSkill/issues/336)). The daemon
  runs the new executable once before relying on it, starts a daemon from it,
  and exits only after that daemon answers. If the new daemon exits or is not
  ready within 20 seconds, the previous executable is put back and the running
  daemon serves again on the same port; the release is retried after 6 hours.
  This applies on all platforms.
- Windows self-update no longer depends on a detached script: the running
  `bsk.exe` is renamed aside and the new one takes its place.
- `bsk update` installs and checks the new executable before stopping the
  daemon, and puts the previous executable back if the restarted daemon does
  not become ready. It restarts the daemon from the installed path, which
  Linux no longer reports as the current executable once it is replaced.

### Changed

- Daemons started with `--foreground` no longer install updates or replace
  themselves with a detached process, on any platform. They log a new version
  once, and the CLI hint suggests `bsk update`.
- A daemon that cannot write next to its executable reports new releases
  instead of installing them, and the CLI hint points to the installer.
- Each update attempt, including the stage and error of a failure, is kept in
  `update-state.json` in the bsk home and shown by `bsk doctor`.
- `bsk update --json` reports `"status": "updated"` on Windows too; the
  `"staged"` status is gone.
- README documents `BSK_AUTO_UPDATE=off`.

## [0.3.1] - 2026-09-23

### Added

- [Task-scoped website debugging](docs/website-debugging.md): bounded request/body
  capture, operation-linked console and page context, browser-local history and JSON export,
  CLI and DSH entry points, and an extension evidence workspace. Existing popup
  controls are preserved, with an additive current-task card.
- Debug operation cards now include manual inputs, field-change chains, delayed
  evidence, source-aware noise filtering and explicit capture gaps.
- Website debugging: task-scoped HTTP rules and request replay, native performance
  metrics, request aggregation and duplicate-request analysis.
- Remote gateway task previews and attribution of agent-opened popups and tabs
  to the task that opened them.
- Browser instance naming in the extension popup and explicit
  [browser profile selection](docs/browser-profiles.md) across CLI, DSH and skill guidance.
- Seven additional interface languages: Traditional Chinese, Japanese, French,
  Italian, Spanish, German and Brazilian Portuguese.
- CLI and DSH skill reference bundles with resource-path validation, safe upgrades
  and migration of existing managed installations.

### Changed

- Extension privacy policies now describe website debugging data, browser-local
  history retention and deletion, requested sharing, and redaction limits.
- DSH Plugin: align SDK dependencies with `0.1.5-rc.3`, Cordis `4.0.2` and
  Schemastery `3.18.2`.
- Reduce repeated observation work by reusing sibling context for repeated action labels.
- Skill guidance clarifies installation prerequisites, browser readiness, profile
  selection and the treatment of page content as untrusted data.

### Fixed

- Recoverable browser session startup and stop handling, including pending cleanup
  and protection of shared daemons after launcher timeouts.
- Windows daemon startup isolation from caller job objects.
- Background navigation and viewport/full-page screenshots without activating
  controlled tabs; full-page capture at fractional DPI and with overlay scrollbars.
- Bounded renderer and frame reads, preserving usable observations when optional
  layout reads time out and preventing overlapping reads after a timeout.
- Keep page actions visible beside nonmodal sidebars and honor accessibility modality.
- Prevent control overlays from swallowing clicks and clear stale overlays when
  observed tabs are released.
- Accept lowercase special keys, match ARIA loading states case-insensitively,
  return visible option labels from selection, and retain same-URL reloads in recordings.
- Deliver navigation timeout results before transport expiry and bound human-help cleanup.
- Enforce remote device capacity across pending connections and preserve active
  sessions while renaming browser instances.
- DSH Plugin: settle commands when child processes exit without closing their
  streams, bound cancellation and output draining, and preserve completed results.
- DSH Plugin: restore lazy tool registration after plugin reloads and resumed
  conversations without repeatedly scanning streaming history.
- DSH Plugin: render screenshot cards independently of host attachment UI components,
  preserve previews across host rerenders, and keep extreme-aspect-ratio thumbnails usable.
- Preserve managed skill source links and handle CRLF metadata and incomplete installations.

## [0.3.0] - 2026-09-16

### Added

- [Remote browser connections](docs/remote-extension-connection.md) with a built-in
  server, one-use pairing links, device credential renewal and revocation, and
  support for native TLS or a TLS reverse proxy. Remote upload and download are unsupported.
- [Operation audit](docs/operation-audit.md): opt-in task history stored on the
  daemon host, with redacted operation metadata, export, deletion and 30-day retention
- [Full-page screenshots](docs/long-screenshot.md) from extension Quick Actions and
  the CLI, with streamed PNG output, cancellation and lazy-loaded page capture
- Canvas visual refs, on-demand element screenshots and screenshot-bound point
  clicks; observation cursor continuation when an explicit token limit is used
- [Scroll-to element primitive](docs/scroll-to.md) across CLI, Extension and DSH Plugin,
  with ancestor-clipped visible bounds, iframe support and cooperative cancellation
- Native [mouse-wheel input](docs/wheel.md), explicit focus and blur actions
- [Host-managed daemon setup](docs/sandboxed-agents.md) with `BSK_HOME` and
  `BSK_AUTO_START=0` for agents whose command sandboxes reap background processes
- Configurable local connection port in the extension popup and Korean localization

### Changed

- **Automation settings:** the extension's saved borrow-confirmation and human-help
  switches govern existing and new sessions. `--unattended`, `tab borrow --no-confirm`
  and `BSK_REQUEST_HELP=off` are deprecated compatibility inputs and cannot override
  these switches. Set the browser preferences when upgrading unattended workflows.
- Managed CLI skills update only while their content matches the installed baseline;
  custom instructions and local edits are preserved, with recovery guidance in `doctor`
- DSH Plugin: use the native browser sidebar when available, with a floating-panel fallback

### Fixed

- Windows installer path handling, verification of the resolved executable, and
  replacement of installations using a daemon from another directory
- Browser connection preference recovery and compatibility during staggered component upgrades
- Observation document and frame geometry consistency, Canvas target identity checks,
  and screenshot/session cleanup during cancellation or navigation

## [0.2.1] - 2026-09-09

### Changed
- DSH Plugin: clarified installation, configuration, profile restart, and upgrade instructions

### Fixed
- CLI: reliable Windows self-updates, including executable replacement and daemon restart
- CLI: Windows named-pipe connection continuity and stale daemon process detection
- Windows installer: PowerShell 5.1 compatibility, path quoting, and staged executable replacement
- CLI / DSH Plugin: cancellation propagation and upload/download cleanup when the parent process exits
- Extension: tab ownership and session cleanup when agent tabs fail to open or borrowed tabs are returned or closed
- Extension: navigation recovery when other extensions restrict Chrome DevTools Protocol access
- Extension: background input filling, automatic append behavior, and verification of field values before reporting success
- Extension: match observed form state to the correct element after page changes
- Extension: UUID generation fallback for recording and overlays on insecure origins
- Browser locale matching for regional language variants
- DSH Plugin: observation state synchronization, thumbnail capture lifecycle, and stale preview cleanup
- DSH Plugin: removed the obsolete client runtime host dependency

## [0.2.0] - 2026-09-02

### Added
- File transfer: upload and download support across CLI, Extension, and DSH Plugin
- File transfer: drag-and-drop upload (`drop-to-upload`)
- VOM semantic graph, name enrichment, and hover perception modules
- VOM hover probing (opt-in via `observe` parameter)
- DSH Plugin: browser tool parity with CLI commands
- Edge Add-ons automated publishing in CI
- Protocol upgrade reminder when CLI / Extension protocol versions differ
- Browser evaluation harness (`evals/browser/`)
- Unified release script (`scripts/release.mjs`)

### Changed
- **Version scheme**: all three components now share the same semver
- VOM rendering algorithm optimizations
- Leaner SKILL.md agent instructions
- DSH Plugin: simplified browser commands
- Borrow confirmation UX — proactive focus and longer timeout
- PiP window now has a close button

### Fixed
- Screenshot media type detection (was hard-coded to `image/png`)
- DSH Plugin session lifecycle stability
- DSH Plugin Cordis package ID mismatch
- Observation thumbnail media type sniffing
- Upload/download race conditions and layout bypass issues
- VOM repeated name and safety policy issues

---

*Previous releases used independent version numbers per component.*

## CLI 0.1.11 / Extension 0.1.7 / DSH Plugin 0.1.2 — 2026-08-26 ~ 2026-08-29

### Added
- DSH Plugin sidebar integration, session lifecycle, and archive cleanup
- Recorder iframe and OOPIF support

### Changed
- VOM functional refactor

### Fixed
- Recorder safety policy and bug fixes

## CLI 0.1.10 / Extension 0.1.6 — 2026-08-08

### Added
- VOM observation recording and settled-state detection
- Record overlay timer

### Fixed
- Browser keepalive disconnect handling

## CLI 0.1.9 / Extension 0.1.5 — 2026-07-29

### Added
- CLI auto-update mechanism
- Trace v3 protocol and recorder

### Fixed
- MV3 keepalive disconnect

## CLI 0.1.8 / Extension 0.1.4 — 2026-07-22

### Added
- More browser interaction actions

### Fixed
- Windows named-pipe hash-only path issue

## CLI 0.1.7 / Extension 0.1.3 — 2026-07-07

Initial public release pair.

## CLI 0.1.6 — 2026-06-30

### Fixed
- Minor CLI fixes

## CLI 0.1.5 / Extension 0.1.2 — 2026-06-22

First tagged releases.
