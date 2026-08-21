//! Keep installed `SKILL.md` files in sync with the `bsk` binary's
//! bundled copy. Best-effort: I/O errors are recorded, never thrown.

use std::path::Path;

use super::{
    DEFAULT_SKILL_MD, SOURCE_CUSTOM, SOURCE_MARKER_FILE, bundled_source_marker, harness::HarnessId,
};

/// SHA-256 hex digests of `SKILL.md` content that `bsk` shipped in
/// earlier releases, before `.bsk-source` markers existed. When a
/// marker-less installed `SKILL.md` matches one of these
/// fingerprints (or the current bundle), the daemon recognises it
/// as a managed bundled install and rewrites it to the current
/// bundle in the same sync pass. Without this list, anyone who
/// installed before markers landed would be silently preserved as
/// "unknown" forever, frozen on the version they first installed.
const HISTORICAL_BUNDLED_FINGERPRINTS: &[&str] = &[
    // Initial public release
    "28d39215d1a6f658d55a41b8ecc2c6692bed628093824442927581f4a3e1bc5a",
    // feat(record): add popup quick-actions launcher and make record --url optional
    "875affb61f68c62712e038bb2a3a54efeaa20974aeab516aaaacd9605e25aa5a",
    // fix(record): use example.com as the default record start URL
    "c3d933f6390199b9a250e6fc66e441c0817fbceb16403d760606ff9bcd3c25ba",
    // fix(runtime): fix early control return and update lifecycle
    "735bd85400e725c33ebb1146bf55d1f997fd4e7f6b785da52fe600a5cd81d4ca",
    // fix(vom): bug fix
    "352d51bb05f38f71a88b2bfe87fb39295e2a3165bb7e56ff505e68b25336b581",
    // feat(request-help): add BSK_REQUEST_HELP=off to disable blocking help requests
    "f93715bfa657922e0753793552f69aa7077dc06109466a9770f1016881e7d962",
    // feat: support Agent Window sizing
    "df897c39d725123e3fd8884b3ab911fa2c21694844c16cde56899d4e3b55033b",
    // feat(emulate): add mobile device emulation via CDP Emulation domain
    "7556a415ec6144b5aa45afa4218687bb3fbda48936748c63e093504f6be13ab0",
    // feat(extension): add bsk hover and adjust vom to support
    "d5eb9c2e826828ee380c76c24afffb593ef13b8fb7d6a596df71a719e7b1d83a",
    // feat(update): auto-upgrade bsk when daemon finds a newer version (#77)
    "4d357816676a989cc28f930951f4d1259d1655c00af85d4c0c429eca398d243d",
    // docs(skill): list bsk console and bsk network in SKILL.md (#84)
    "cfb4934ff5647b3d9220c287bfde4f813948dc562dc5915e1ce3362a9e631b5c",
    // feat(session): support unfocused agent windows (--no-focus) (#87)
    "a4c6a616f2b52a23f66de700fe7c41f11e854cd51997c85f03f3f3a22a1b7279",
];

/// Per-harness outcome of a sync pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Harnesses whose on-disk `SKILL.md` differed and was rewritten.
    pub updated: Vec<HarnessId>,
    /// Harnesses whose on-disk `SKILL.md` already matched the bundled
    /// content; no write happened, mtime preserved.
    pub up_to_date: Vec<HarnessId>,
    /// Harnesses whose skill is custom, manually edited, or otherwise
    /// marker-less installations we don't recognise. Automatic sync
    /// preserves them; legacy bundled installs whose content matches a
    /// known historical fingerprint are upgraded instead (see
    /// `HISTORICAL_BUNDLED_FINGERPRINTS`).
    pub preserved: Vec<HarnessId>,
    /// Harnesses that have an installed `SKILL.md` but the sync attempt
    /// failed with an I/O error. The string is a human-readable detail.
    pub errors: Vec<(HarnessId, String)>,
}

/// Iterates `HarnessId::ALL`, syncing harnesses with an existing
/// `SKILL.md` and leaving the rest untouched.
pub fn sync_installed_skills(home: &Path) -> SyncReport {
    sync_with_source(home, DEFAULT_SKILL_MD)
}

/// Test seam: lets unit tests inject a synthetic "bundled" payload.
pub(crate) fn sync_with_source(home: &Path, source: &str) -> SyncReport {
    let mut report = SyncReport::default();
    for &harness in HarnessId::ALL {
        let dest = harness.skill_dest_dir_for_home(home).join("SKILL.md");
        match sync_one(&dest, source) {
            SyncOne::Missing => continue,
            SyncOne::UpToDate => report.up_to_date.push(harness),
            SyncOne::Updated => report.updated.push(harness),
            SyncOne::Preserved => report.preserved.push(harness),
            SyncOne::Error(msg) => report.errors.push((harness, msg)),
        }
    }
    report
}

enum SyncOne {
    Missing,
    UpToDate,
    Updated,
    Preserved,
    Error(String),
}

fn sync_one(dest: &Path, source: &str) -> SyncOne {
    if !dest.is_file() {
        return SyncOne::Missing;
    }
    let on_disk = match std::fs::read_to_string(dest) {
        Ok(s) => s,
        Err(err) => return SyncOne::Error(format!("read {}: {err}", dest.display())),
    };
    let marker = dest
        .parent()
        .expect("SKILL.md destination must have a parent")
        .join(SOURCE_MARKER_FILE);

    // Atomic replace + marker refresh. Used for both stale-managed
    // upgrades and legacy bundled adoptions. Returns Err with a
    // human-readable detail on any I/O failure.
    let atomic_replace = |dest: &Path, source: &str, marker: &Path| -> Result<(), String> {
        let tmp = dest.with_extension(format!("md.tmp.{}", std::process::id()));
        std::fs::write(&tmp, source).map_err(|err| format!("write {}: {err}", tmp.display()))?;
        // Best-effort cleanup if the rename below fails.
        let rename_result = std::fs::rename(&tmp, dest)
            .map_err(|err| format!("rename {} -> {}: {err}", tmp.display(), dest.display()));
        if let Err(err) = rename_result {
            let _ = std::fs::remove_file(&tmp);
            return Err(err);
        }
        std::fs::write(marker, bundled_source_marker(source))
            .map_err(|err| format!("write {}: {err}", marker.display()))
    };

    let managed_marker = match std::fs::read_to_string(&marker) {
        Ok(value) if value == SOURCE_CUSTOM => return SyncOne::Preserved,
        Ok(value) if value.starts_with("bundled:") => value,
        Ok(_) => return SyncOne::Preserved,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // Marker-less file: adopt as managed when the content
            // matches the current bundle or any historical bundled
            // fingerprint. Without this list, anyone who installed
            // before `.bsk-source` markers existed would never be
            // auto-upgraded again.
            let on_disk_marker = bundled_source_marker(&on_disk);
            let is_known_bundle = on_disk == source
                || HISTORICAL_BUNDLED_FINGERPRINTS
                    .iter()
                    .any(|fp| on_disk_marker == format!("bundled:{fp}\n"));
            if !is_known_bundle {
                return SyncOne::Preserved;
            }
            if on_disk == source {
                if let Err(err) = std::fs::write(&marker, bundled_source_marker(source)) {
                    return SyncOne::Error(format!("write {}: {err}", marker.display()));
                }
                return SyncOne::UpToDate;
            }
            // Legacy bundled install: rewrite to current bundle.
            return match atomic_replace(dest, source, &marker) {
                Ok(()) => SyncOne::Updated,
                Err(msg) => SyncOne::Error(msg),
            };
        }
        Err(err) => return SyncOne::Error(format!("read {}: {err}", marker.display())),
    };
    if managed_marker != bundled_source_marker(&on_disk) {
        return SyncOne::Preserved;
    }
    if on_disk == source {
        return SyncOne::UpToDate;
    }
    // Atomic replace: write tmp, rename over. Including pid in the
    // tmp suffix avoids concurrent processes racing on the same path.
    match atomic_replace(dest, source, &marker) {
        Ok(()) => SyncOne::Updated,
        Err(msg) => SyncOne::Error(msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn mark_bundled(dest: &Path, content: &str) {
        std::fs::write(
            dest.parent().unwrap().join(SOURCE_MARKER_FILE),
            bundled_source_marker(content),
        )
        .unwrap();
    }

    #[test]
    fn sync_skips_uninstalled_harness() {
        let tmp = TempDir::new().unwrap();
        let report = sync_with_source(tmp.path(), "anything");
        assert!(report.updated.is_empty());
        assert!(report.up_to_date.is_empty());
        assert!(report.preserved.is_empty());
        assert!(report.errors.is_empty());
        // Defensive: sync must not silently create files in harnesses that
        // never had the skill installed. This guards Task 2's real impl.
        let dest = HarnessId::Cursor
            .skill_dest_dir_for_home(tmp.path())
            .join("SKILL.md");
        assert!(
            !dest.exists(),
            "sync should not create files for uninstalled harnesses"
        );
    }

    #[test]
    fn sync_updates_outdated_skill() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let dest_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("SKILL.md");
        std::fs::write(&dest, b"old content").unwrap();
        mark_bundled(&dest, "old content");

        let report = sync_with_source(home, "fresh content");

        assert_eq!(report.updated, vec![HarnessId::Cursor]);
        assert!(report.up_to_date.is_empty());
        assert!(report.errors.is_empty());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "fresh content");
        // Atomicity guard: no orphan tmp files matching SKILL.md.tmp.* should
        // remain after a successful sync (regardless of pid suffix).
        let leftovers: Vec<_> = std::fs::read_dir(&dest_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name())
            .filter(|name| name.to_string_lossy().starts_with("SKILL.md.tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no SKILL.md.tmp.* files should remain after sync, found: {leftovers:?}"
        );
    }

    #[test]
    fn sync_skips_when_up_to_date() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let dest_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("SKILL.md");
        std::fs::write(&dest, "frozen content").unwrap();
        mark_bundled(&dest, "frozen content");
        let mtime_before = std::fs::metadata(&dest).unwrap().modified().unwrap();

        // Sleep enough that any rewrite would visibly change mtime on
        // platforms with coarse fs timestamps (HFS+ has 1 s granularity).
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let report = sync_with_source(home, "frozen content");

        assert_eq!(report.up_to_date, vec![HarnessId::Cursor]);
        assert!(report.updated.is_empty());
        assert!(report.errors.is_empty());
        let mtime_after = std::fs::metadata(&dest).unwrap().modified().unwrap();
        assert_eq!(
            mtime_before, mtime_after,
            "up-to-date sync should not touch mtime"
        );
    }

    #[cfg(unix)]
    #[test]
    fn sync_continues_on_partial_error() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let home = tmp.path();

        // Cursor: writable, outdated → should be updated.
        let cursor_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&cursor_dir).unwrap();
        std::fs::write(cursor_dir.join("SKILL.md"), "old").unwrap();
        mark_bundled(&cursor_dir.join("SKILL.md"), "old");

        // Codex: parent dir set to r-x. Reads still succeed, but creating
        // SKILL.md.tmp fails → exercises sync_one's write-tmp error branch.
        let codex_dir = HarnessId::Codex.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(codex_dir.join("SKILL.md"), "old").unwrap();
        mark_bundled(&codex_dir.join("SKILL.md"), "old");
        let mut perms = std::fs::metadata(&codex_dir).unwrap().permissions();
        perms.set_mode(0o500); // r-x: blocks tmp creation in this dir
        std::fs::set_permissions(&codex_dir, perms).unwrap();

        let report = sync_with_source(home, "fresh");

        // Restore perms so TempDir can clean up.
        let mut perms = std::fs::metadata(&codex_dir).unwrap().permissions();
        perms.set_mode(0o700);
        std::fs::set_permissions(&codex_dir, perms).unwrap();

        assert_eq!(report.updated, vec![HarnessId::Cursor]);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].0, HarnessId::Codex);
    }

    #[test]
    fn sync_preserves_custom_edited_and_unknown_skills() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();

        let custom_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&custom_dir).unwrap();
        std::fs::write(custom_dir.join("SKILL.md"), "custom content").unwrap();
        std::fs::write(custom_dir.join(SOURCE_MARKER_FILE), SOURCE_CUSTOM).unwrap();

        let edited_dir = HarnessId::Codex.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&edited_dir).unwrap();
        std::fs::write(edited_dir.join("SKILL.md"), "managed then edited").unwrap();
        mark_bundled(&edited_dir.join("SKILL.md"), "original managed content");

        let unknown_dir = HarnessId::ClaudeCode.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&unknown_dir).unwrap();
        std::fs::write(unknown_dir.join("SKILL.md"), "historical content").unwrap();

        let report = sync_with_source(home, "new bundled content");

        assert_eq!(
            report.preserved,
            vec![HarnessId::Codex, HarnessId::ClaudeCode, HarnessId::Cursor]
        );
        assert_eq!(
            std::fs::read_to_string(custom_dir.join("SKILL.md")).unwrap(),
            "custom content"
        );
        assert_eq!(
            std::fs::read_to_string(edited_dir.join("SKILL.md")).unwrap(),
            "managed then edited"
        );
        assert_eq!(
            std::fs::read_to_string(unknown_dir.join("SKILL.md")).unwrap(),
            "historical content"
        );
    }

    #[test]
    fn sync_adopts_markerless_current_bundle_then_updates_it() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let dest_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("SKILL.md");
        std::fs::write(&dest, "current bundle").unwrap();

        let first = sync_with_source(home, "current bundle");
        assert_eq!(first.up_to_date, vec![HarnessId::Cursor]);
        assert_eq!(
            std::fs::read_to_string(dest_dir.join(SOURCE_MARKER_FILE)).unwrap(),
            bundled_source_marker("current bundle")
        );

        let second = sync_with_source(home, "next bundle");
        assert_eq!(second.updated, vec![HarnessId::Cursor]);
        assert_eq!(std::fs::read_to_string(dest).unwrap(), "next bundle");
    }

    #[test]
    fn sync_adopts_markerless_legacy_bundle_and_upgrades_it() {
        // Historical bundled SKILL.md content from the initial public
        // release (sha256 28d39215...d4a3e1bc5a, listed in
        // HISTORICAL_BUNDLED_FINGERPRINTS). A user with this exact
        // on-disk content and no marker would, before this fix, be
        // silently preserved as "unknown" forever once the bundled
        // SKILL.md changed.
        const LEGACY_SKILL_MD: &str = "---\nname: browser-skill\ndescription: |\n  Use when the user asks to perform browser automation tasks against their\n  logged-in browser: visit and read pages, fill forms, scrape data, click\n  through a flow, regression-test a PR's UI, validate a deployed page.\n  Requires the bsk CLI installed and the browser-skill extension loaded.\n---\n\n# browser-skill\n\nDrive the user's **real Chromium browser** (with their logins and cookies) through the `bsk` CLI. The extension opens an isolated **Agent Window** for automation; the user's normal windows stay protected unless you explicitly borrow a tab.\n\n## When to use\n\n- Open pages, read titles/text, scrape structured data from sites the user can already access\n- Fill forms, click through multi-step flows, smoke-test a UI change\n- Understand pages with `bsk snapshot` first; use `bsk get-html` or `bsk screenshot` only when the snapshot is insufficient\n- Operate on a specific user tab they point you at (after `bsk tab borrow`)\n\n## When NOT to use\n\n- Tasks with **no browser** involved (files, APIs, databases only)\n- Installing or configuring the extension (point the user to setup docs instead)\n- **Credential harvesting** — never run `bsk evaluate` on banking, SSO, or password-manager pages to extract tokens, cookies, or secrets\n- Long-lived control of a user's personal login window — borrow only for the immediate step, then `bsk tab return` or end the session\n- Replacing the user's manual browsing when they only wanted an explanation\n\n## Prerequisites\n\n1. `bsk` on `PATH` (Rust CLI from browser-skill)\n2. browser-skill **extension** loaded in Chromium and connected (popup shows green)\n3. Any `bsk` command auto-starts background services as needed; use `bsk doctor` if anything fails\n\n## Mandatory workflow\n\nEvery automation task **must** follow this lifecycle. Do **not** rely on idle timeouts (default session idle is 5 minutes).\n\n```\n1. bsk session start              → capture the 4-letter session id printed on stdout\n2. … every tool command …        → always pass --session <id>\n3. bsk session stop <id>          → REQUIRED when done (even on error paths)\n```\n\nOptional: `bsk session start --browser <instance-id-or-label>` when multiple browsers are connected (`bsk browsers` / error output lists them).\n\nEmergency cleanup: `bsk session stop --all` or the Agent Window overlay **Stop all**.\n\n## Core interaction loop\n\nWrite operations only affect tabs in the **Agent Window** (or tabs you **borrowed** into it).\n\n```\nbsk navigate <url> --session <id>\nbsk snapshot --session <id>          → aria tree with @e1, @e2, … refs\nbsk click @e3 --session <id>          → or bsk fill, bsk select, bsk press\nbsk snapshot --session <id>            → again after navigation / DOM change\n```\n\n**Refs invalidate after navigation** — always re-snapshot before clicking, filling, or selecting on a new page.\n\nPrefer `@eN` refs from the latest snapshot over raw CSS selectors. Use `--ref` / `--selector` when ambiguous (`bsk click --help`).\n\n## Observation priority\n\nStart with `bsk snapshot` to understand page structure, text, controls, and element refs. Only escalate when the latest snapshot cannot answer the question:\n\n1. `bsk snapshot` — default for page understanding and interaction planning\n2. `bsk get-html` — when hidden DOM, metadata, or markup details are required\n3. `bsk screenshot` — when visual layout, canvas/image content, or styling cannot be inferred from the snapshot. Use `--ref @eN` (from the latest snapshot) to crop to one element; omit `--ref` for the full visible tab.\n\nDo **not** call `bsk get-html` or `bsk screenshot` first just to inspect a page.\n\n## Sandbox rules\n\n| Rule | Detail |\n|------|--------|\n| Agent Window | `bsk tab create`, `bsk navigate`, `bsk click`, etc. work on agent tabs by default |\n| User tabs | Read-only until borrowed: `bsk tab list --session <id> --scope user` then `bsk tab borrow <tab-id> --session <id>` |\n| Return borrowed tabs | Call `bsk tab return <tab-id> --session <id>` when finished; unreturned tabs are **auto-returned** on `bsk session stop` |\n| Writes off-agent | Commands that mutate the page fail if the tab is not in the Agent Window — borrow or create a tab first |\n\n## Global flags\n\n| Flag | Purpose |\n|------|---------|\n| `--json` | Machine-readable JSON on stdout (errors too) |\n| `--quiet` | Suppress informational stderr |\n| `-v` / `-vv` | More verbose logging |\n\nCommand-specific flags (timeouts, `--tab-id`, `--wait-until`, …): **`bsk <cmd> --help`**\n\n## CLI command reference (one line each)\n\nDetails and flags: **`bsk <cmd> --help`**\n\n### Diagnostics\n\n| Command | Summary |\n|---------|---------|\n| `bsk status` | Connection health, connected browsers, active sessions |\n| `bsk doctor` | Deep diagnostics and repair hints |\n| `bsk browsers` | List connected browser instances (ids, labels, versions) |\n\n### Session\n\n| Command | Summary |\n|---------|---------|\n| `bsk session start` | Open Agent Window; prints **4-letter session id** |\n| `bsk session stop <id>` | End session, close Agent Window, auto-return borrowed tabs |\n| `bsk session stop --all` | Stop every active session |\n| `bsk session list` | List active sessions |\n\n### Tabs (require `--session <id>`)\n\n| Command | Summary |\n|---------|---------|\n| `bsk tab list` | List tabs (`--scope user\\|agent\\|all`, default `all`) |\n| `bsk tab create` | New tab in Agent Window (`--url`, `--no-active`, `--index`) |\n| `bsk tab close <tab-id>` | Close an agent tab |\n| `bsk tab select <tab-id>` | Focus an agent tab |\n| `bsk tab borrow <tab-id>` | Move a user tab into the Agent Window |\n| `bsk tab return <tab-id>` | Return a borrowed tab to its original window |\n\n### Observation (require `--session` unless noted)\n\n| Command | Summary |\n|---------|---------|\n| `bsk snapshot` | First-choice page understanding: accessibility tree with `@eN` element refs |\n| `bsk get-html` | Raw HTML dump after snapshot is insufficient (high token cost) |\n| `bsk screenshot` | PNG capture after snapshot is insufficient: full visible tab, or `--ref @eN` to crop to one element (`--out` path optional) |\n\n### Navigation\n\n| Command | Summary |\n|---------|---------|\n| `bsk navigate <url>` | Go to URL in agent tab (`--wait-until`, `--timeout`) |\n| `bsk navigate-back` | History back one step |\n| `bsk navigate-forward` | History forward one step |\n| `bsk reload` | Reload current tab (`--hard` bypass cache) |\n\n(`bsk navigate back` / `bsk navigate forward` are equivalent subcommands.)\n\n### Interaction\n\n| Command | Summary |\n|---------|---------|\n| `bsk click <ref-or-selector>` | Click element (`--button`, `--click-count`, `--modifiers`) |\n| `bsk fill <ref-or-selector> --value <text>` | Clear and type into input |\n| `bsk select <ref-or-selector> --value <v>` | Set `<select>` option(s) by `value` (repeat `--value` for multi-select) |\n| `bsk press <key>` | Key/combo (`Enter`, `Ctrl+A`, …; optional `--ref` to focus first) |\n\n### Scripting & timing\n\n| Command | Summary |\n|---------|---------|\n| `bsk evaluate <expression>` | Run JS in agent tab (see red lines); JS throw → stderr, **exit 0** |\n| `bsk wait-for-navigation` | Block until load/DOM idle/etc. (`--wait-until`, `--timeout`) |\n| `bsk wait-ms <duration>` | Sleep (`500ms`, `2s`, `1m`; **no** `--session`) |\n\n### Ask the human for help — `bsk request-help`\n\nWhen a step needs a human (captcha, login, OTP) or you want the user to\nconfirm an important action, pause and ask:\n\n    bsk request-help --session <id> --prompt \"Solve the captcha, then click Continue\" \\\n      --title \"Captcha required\" --target @e7 --target \"#submit\" --timeout 5m\n\n- `--prompt` (required): what the user should do.\n- `--title` (optional): custom title for the overlay panel. When omitted,\n  the extension shows its default localized title.\n- `--target` (repeatable): a snapshot ref (`@e7`) or CSS selector\n  (`#submit`) to scroll to and flash-highlight. **Strongly recommended** —\n  whenever the prompt refers to a concrete element (a button to click, a\n  field to fill, a checkbox to toggle), pass its `@eN` ref / selector so the\n  user is guided straight to the right spot instead of hunting for it. For\n  interaction scenarios, always include the relevant target(s); reserve a\n  prompt with no `--target` for cases where there is genuinely no specific\n  element to point at (e.g. \"wait for the page to finish loading\").\n- `--timeout` (default `5m`): how long to wait.\n\nThe target tab is brought to the foreground; the page stays interactive\nwhile the agent control mask is hidden. The call blocks until the user\nacts. The result `outcome` is one of:\n\n- `continued` — the user finished and clicked Continue (treat as confirm).\n- `cancelled` — the user clicked Cancel (treat as reject/abort).\n- `timed_out` — nobody acted within the timeout.\n- `navigated` — the page navigated while waiting (full reload or SPA URL change). Snapshot refs are stale; run `bsk snapshot` on the new page, then decide whether to call `bsk request-help` again.\n\n`note` carries any text the user typed back. `resolved_targets` reports\nwhich refs/selectors matched a live element.\n\n## Error handling\n\n### Exit codes (`echo $?` after `bsk …`)\n\n| Code | Meaning | What to do |\n|------|---------|------------|\n| `0` | Success (including `evaluate` where JS threw but RPC succeeded) | Continue |\n| `1` | User error — bad args, unknown session, tab not in Agent Window, stale ref | Fix args; `bsk session list`; re-snapshot |\n| `2` | Protocol / transport — service unreachable, IPC failure | `bsk doctor`; check extension connected; retry the command |\n| `3` | Browser / CDP execution failed | Retry; simplify selector; check tab still open |\n| `4` | Timeout | Increase `--timeout`; try `--wait-until domcontentloaded` |\n| `5` | Version skew (CLI vs extension) | Upgrade/reinstall matching versions |\n\nHuman errors print `error:` + `hint:` on stderr; `--json` includes `code`, `message`, `hint`, `exit_code`.\n\n### When to run diagnostics\n\n| Situation | Command |\n|-----------|---------|\n| Before first task in a session | `bsk status` — extension connected? |\n| Any failure you cannot fix in one retry | `bsk doctor` |\n| Multiple browsers / wrong target | `bsk browsers` then `bsk session start --browser <id>` |\n\nAlways **`bsk session stop <id>`** in a `finally`-style path so the Agent Window closes and borrowed tabs return.\n\n## Red lines\n\n1. **No token theft** — do not `bsk evaluate` on sensitive sites to read `localStorage`, cookies, or auth headers for exfiltration.\n2. **No long borrow** — do not leave a user's personal tab in the Agent Window across unrelated tasks.\n3. **No skip stop** — always `bsk session stop <id>`; never assume idle timeout will clean up.\n4. **No observe escalation before snapshot** — use `bsk snapshot` first; only use `bsk get-html` or `bsk screenshot` when the snapshot is insufficient. Element screenshots (`--ref @eN`) still require a fresh snapshot ref — never skip snapshot just to grab a visual.\n5. **`evaluate` is powerful and risky** — use only when snapshot + click/fill/select cannot suffice; never on credential surfaces.\n\n---\n\n**More detail for any command:** `bsk <cmd> --help`\n";
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let dest_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&dest_dir).unwrap();
        std::fs::write(dest_dir.join("SKILL.md"), LEGACY_SKILL_MD).unwrap();
        // Sanity: the legacy content must really hash to the fingerprint
        // we expect, otherwise the test only proves its own artefact.
        assert_eq!(
            bundled_source_marker(LEGACY_SKILL_MD),
            format!(
                "bundled:{}\n",
                "28d39215d1a6f658d55a41b8ecc2c6692bed628093824442927581f4a3e1bc5a",
            ),
            "legacy fixture must hash to its claimed fingerprint",
        );

        let report = sync_with_source(home, "current bundle");

        assert_eq!(report.updated, vec![HarnessId::Cursor]);
        assert_eq!(report.preserved, Vec::new());
        assert_eq!(
            std::fs::read_to_string(dest_dir.join("SKILL.md")).unwrap(),
            "current bundle",
            "legacy install should be rewritten to the current bundle",
        );
        assert_eq!(
            std::fs::read_to_string(dest_dir.join(SOURCE_MARKER_FILE)).unwrap(),
            bundled_source_marker("current bundle"),
            "fresh bundled marker must be stamped after the upgrade",
        );
    }
}
