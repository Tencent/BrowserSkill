# bsk

Command-line interface and background daemon for [BrowserSkill](https://github.com/Tencent/BrowserSkill).

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh | sh
export PATH="${BSK_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
```

Documentation: [../../README.md](../../README.md) · [../../docs/architecture.md](../../docs/architecture.md)

## Flags and errors

`--json`, `--quiet`, and `--verbose` are global flags and may appear before or
after the subcommand. `--session` and `--tab-id` belong to the commands that
support them; place them after the concrete subcommand:

```sh
bsk --json click --session <id> --tab-id <tab> --selector '#submit'
bsk tab list --session <id> --json
```

With `--json`, argument parsing failures also write a JSON error to stdout,
including when parsing stops before reaching the flag. The error has the usual
`code`, `message`, `hint`, `exit_code`, and `data` fields, with
`code: "invalid_params"`, `data.reason: "cli_parse_error"`, and exit code `1`.
`message` is a one-line summary such as
`unexpected argument '--session' found`; `data.details` holds the full parser
text, including tips and usage. This applies to redirected stdout as well.
Without `--json`, usage errors go to stderr. `--help` and `--version` still
print normal text and exit successfully. A literal `--json` after `--` is a
positional value, not an output flag.

## Screenshots

```sh
bsk screenshot --session <id> --out viewport.png
bsk screenshot --session <id> --ref @e3 --out element.png
bsk screenshot --session <id> --full-page --out page.png
bsk screenshot --session <id> --full-page --timeout 5m --out page.png
```

`--full-page` scrolls an ordinary HTTP(S) page from top to bottom, including content
loaded while scrolling, and restores the original scroll position and temporary styles.
Keep the target selected and its viewport stable. The tab must belong to the session
(create or borrow it first). `--tab-id` selects an explicit target; it does not activate it.
Full-page capture and PNG encoding default to a two-minute timeout; `--timeout` changes
that deadline and requires `--full-page`. `--ref` and `--full-page` are mutually exclusive.
Ctrl-C cancels capture or transfer. Failed captures do not save a partial image.

PNG data is stitched on disk and transferred in 256 KiB chunks. The CLI writes a temporary
file beside the output and atomically replaces the destination only after receiving all
bytes. Like other screenshot modes, an existing output file is replaced on success.
Omitting `--out` saves in the system temporary directory. `--json` returns the same
`tab_id`, `width`, `height`, `format`, `path` and `byte_size` fields for all screenshot modes.
The extension's popup result and browser download folder are not involved.

Full-page mode needs a matching CLI and extension build. After updating the CLI,
restart an existing daemon with `bsk daemon restart`. It does not automate Chrome
internal pages, the Web Store, nested scrolling panels or virtualized lists. It follows
the page's document scroll; endlessly growing pages can reach the chosen timeout.
See [long screenshot behavior and implementation](../../docs/long-screenshot.md).
