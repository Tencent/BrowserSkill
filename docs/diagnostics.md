# BrowserSkill diagnostics

When BrowserSkill cannot connect to the extension or open a session, capture
its local state before restarting the daemon or running repairs. Run this on
the machine that runs the CLI, with the same `BSK_HOME` as the failing command.

```sh
bsk diagnostics export --output diagnostics.zip
```

Choose a new filename in an existing directory. The command finishes the ZIP
in a temporary file in that directory and refuses to overwrite an existing
file. Add `--json` to receive the output path and size in bytes.

## Reading the bundle

| File | What it contains |
| --- | --- |
| `metadata.json` | CLI and protocol versions, operating system, architecture and collection time in Unix seconds. |
| `doctor.json` | Health checks and repair hints for the state observed during export. The home write test and managed skill synchronization are skipped. |
| `status.json` | One snapshot from the existing daemon, including its version, connected browsers and daemon-wide session summaries. If the daemon is missing or its IPC endpoint fails, this file contains `null`. The **daemon running** check in `doctor.json` gives the reason. |
| `daemon-log.txt` | Up to 500 trailing lines from the latest daemon log, limited to 4 MiB after redaction. Older lines and any partial leading line are dropped. |
| `README.txt` | Availability and truncation notes. If the log is missing or unreadable, the note explains why the log entry was omitted. |

Export works without an active session, a connected extension or a running
daemon. It reads local files and queries an existing daemon without waiting
for a browser. It does not start the daemon, prepare its home, change
permissions or update installed skills.

## Privacy and scope

The ZIP stays on disk. Export does not upload anything. Session summaries and
logs cover the **whole daemon** and can include activity from other sessions.
JSON credential fields are masked recursively. Free text is checked for common
credential assignments, authorization schemes, URL credentials and BrowserSkill
pairing links. Cookie and Authorization header values are masked in full.
Unlabelled secrets, local paths, profile labels and application data can still
be present. Inspect the entries before sharing them.

This export covers the CLI and daemon portion of [issue #335](https://github.com/Tencent/BrowserSkill/issues/335).
Extension debug-page contents are outside its scope. For requests, console
messages or page evidence from a website task, see [Website debugging](website-debugging.md).
