# Changelog

All notable changes to BrowserSkill will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

Starting from 0.2.0, CLI / Extension / DSH Plugin share the same version number.

## [Unreleased]

### Added

- [Scroll-to element primitive](docs/scroll-to.md) across CLI, Extension and DSH Plugin,
  with ancestor-clipped visible bounds, iframe support and cooperative cancellation

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
