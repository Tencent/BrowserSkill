# bsk

Command-line interface and background daemon for [BrowserSkill](https://github.com/Tencent/BrowserSkill).

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh | sh
```

Documentation: [../../README.md](../../README.md) · [../../docs/architecture.md](../../docs/architecture.md)

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
