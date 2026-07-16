# Semantic recording (`bsk record`)

Record a user flow as an LLM-readable **textbook** (`trace.json`).

**本需求只交付录制：** 得到 `trace.json` 即结束。  
**不**新增执行 / 回放命令或引擎。事后若要完成同类操作，**完全复用已有** `bsk session` / `snapshot` / `@eN` / `click` / `fill` 等能力（由 LLM 或人读教材后自行调用）。

## Quality bar for each step

Every recorded step should answer: **「这一步要找什么、做什么？」**

| Good (LLM can act) | Bad (drop / never record) |
|--------------------|---------------------------|
| `点击「发布」按钮` | `点击div` / `{ "tag": "div" }` |
| `在「服务名称」填入 my-svc` | 只有 CSS 路径或 `@eN` |
| `点击「Tencent 腾讯」链接` | 无名布局空白、装饰点击 |

Recording the control’s **visible name** is the usual way to meet this bar (not a rigid schema mandate): whatever we store, the LLM must be able to know *where* to click/fill next.

## Product loop

```text
（可选）purpose + 录制 steps
        ↓
写出 trace.json          ← 本需求边界
        ↓
（既有能力，非本需求）LLM 读教材或用户描述 → 常规 bsk 工具循环
        ↓
目标达成后立即 session stop（见 skill「Stop when the goal is met」）
```

There is **no** `bsk replay` and **no** new execute-from-trace API in this change. Agents may also act from a plain user request without a textbook; either path must stop controlling the browser as soon as the goal is met.
## CLI

```bash
bsk record start [--purpose "..."] --url https://... [--output trace.json]
# `--url` is required for a fresh session (Agent Window boots on about:blank).
# Blocks until the user clicks Finish / 结束 in the browser panel.
# Writes ./trace.json by default, then closes the Agent Window.

bsk record stop [--output trace.json]   # terminal fallback
```

## UI

After `record start`, the Agent Window shows a bottom panel:

- Status: **正在录制用户操作** / “Recording your actions”
- Button: **结束** / “Finish”

The control mask is hidden so the page stays interactive. Clicking Finish stops capture, saves the trace, and closes the window.

## `purpose` is metadata only

| Stage | Does `purpose` affect it? |
|-------|---------------------------|
| Capture rules (fill commit, ignore suggestion clicks, semantic targets) | **No** |
| Filtering “irrelevant” actions by goal | **No** (not in this phase) |
| Post-hoc LLM understanding of *why* the flow exists | **Yes** — written to `trace.json` top-level when provided |

Omitting `--purpose` still produces a complete trace.

## Trace shape (v3)

LLM textbook: each step has `id` / `op` / `intent` / `importance` / `page` / `summary`, plus op-specific fields. Action-caused navigation becomes `effect`, not a separate wait step. Variable inputs are **not** auto-extracted (`parameters[]` omitted) — downstream LLM infers them from control names + `value`.

```json
{
  "version": 3,
  "purpose": "…",
  "recorded_at": "…",
  "entry": {
    "start_url": "…",
    "start_url_pattern": "…",
    "site": "…"
  },
  "steps": [
    {
      "id": 1,
      "op": "fill",
      "intent": "provide_input",
      "importance": "essential",
      "target": { "role": "textbox", "name": "服务名称", "tag": "input", "name_attr": "serviceName" },
      "value": "my-svc",
      "summary": "在「服务名称」填入 my-svc",
      "page": { "url_pattern": "https://example.com/*/edit", "role": "editor" }
    },
    {
      "id": 2,
      "op": "click",
      "intent": "confirm",
      "importance": "essential",
      "target": { "role": "button", "name": "发布", "tag": "button" },
      "summary": "点击「发布」按钮",
      "effect": {
        "navigated_to": "https://example.com/p/99",
        "url_pattern_after": "https://example.com/p/*"
      }
    }
  ]
}
```

**Forbidden in the export:** `@eN`, tracking hrefs as primary descriptors, deep `nth-of-type` CSS paths, standalone `wait_for_navigation`, anonymous layout clicks (`{ "tag": "div" }` with no name).

**Capture rules:**
- FillSession emits the final value only; autocomplete/suggestion clicks are ignored
- Clicks are recorded only for **named interactive** controls (button/link/role + accessible name); bare `div`/`span` chrome is dropped
- Passwords become `"***"` with `redacted: true`
- `press` keeps Enter/Escape; drops bare typing and Meta/Ctrl+a|c|v|x noise
- URLs are patternized (drop tracking query, collapse numeric path ids)

## Manual check

1. `bsk record start --purpose "demo"` (or without purpose)
2. Confirm the recording panel appears
3. Perform a few clicks/fills (optionally Enter to submit)
4. Click **结束**
5. Open `./trace.json` — `version` is `3`, steps have `intent`/`summary`/`page` or `effect`, no `@eN` / `parameters`
