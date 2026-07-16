# 改动评审：语义化录制（Semantic Record / Trace v2）

| 项 | 内容 |
|----|------|
| **对比基线** | **远程仓库 `origin/main`（`bc05ef5` Initial public release）** |
| 工作分支 | `new_record`（当前 tip 与 `origin/main` 同 commit；改动均在工作区，尚未提交） |
| **本需求范围** | **只新增录制能力**：人工操作 → 写出语义 `trace.json`。交付物到文件落盘即结束 |
| **不在本需求** | 任何新的执行 / 回放能力（无 `bsk replay`、无 trace 执行引擎、无自动 semantic→`@eN`） |
| **事后怎么跑** | **完全复用 `origin/main` 已有能力**：`session` + `snapshot`/`@eN` + `click`/`fill`/`press`…（由 LLM/Agent 读教材后自行调用，本 PR 不新增执行路径） |
| 产品说明 | [docs/semantic-record.md](./semantic-record.md) |

> **评审口径：** 以下所有「新增 / 修改」均相对 **`origin/main` 原始版本**。  
> 远程 `main` 无 record；本需求 **仅** 从零加入录制端。执行侧零新增，靠既有工具闭环。

---

## 1. 相对 `origin/main`：远程原先没有什么 / 本需求加什么

在 `origin/main`（公开初始版本）中：

- **无** `tool.record_*`、**无** `bsk record`、**无** 录制 overlay
- **已有**（本需求执行侧直接复用、不改语义）：`session`、`navigate`、`snapshot`、`click`/`fill`/`press`/`select`、`request-help` 等

本需求 **只新增录制端**：

```text
人工在 Agent Window 操作
        ↓
语义捕获 → Trace v2
        ↓
写出 ./trace.json          ← 本需求交付边界
```

**不在本需求内：** 读 trace 并驱动浏览器的新代码 / 新 CLI / 新协议方法。  
事后若要用教材完成同类任务，Agent 按既有 skill 流程调用现有 `bsk` 命令即可。

### 产品决策

1. **默认输出** `./trace.json`（`--output` 可覆盖）
2. **`purpose` 可选元数据**：写入 JSON 供 LLM 理解目标；**不**参与录制期过滤
3. **UI**：底部「正在录制用户操作」+「结束」；点结束后写文件并关窗
4. **Trace 主键**：语义 `target` + `summary`；禁止「点击div」类无意义步骤

与既有能力的关系：

```text
本需求：  bsk record → trace.json（教材）
既有能力： LLM 读教材 → bsk session/snapshot/click/fill…（零新增执行代码）
```

---

## 2. 改动总览（vs `origin/main`）

| 层 | 相对远程 main 的变化 |
|----|----------------------|
| Protocol | **新增** Trace v2、`tool.record_start\|stop\|await`、schema；**无** replay / execute 类方法 |
| Extension | **新增**语义捕获、录制 overlay、record 编排；**不**新增按 trace 执行的工具 |
| CLI | **新增** `bsk record start\|stop`；**无** `bsk replay` |
| Docs / i18n | 录制说明与 UI 文案 |

**验收标准（本需求）：** `bsk record …` → 得到合格的 `trace.json`。不要求、不交付任何自动执行路径。

---

## 3. 协议（`bsk-protocol`）— vs `origin/main`

### 新增

- [`crates/bsk-protocol/src/tools/record.rs`](../crates/bsk-protocol/src/tools/record.rs)
  - `TargetDescriptor`：`role?` / `name?` / `tag` / `name_attr?`
  - `Trace`：`version: 3`，可选 `purpose`，`recorded_at`，`entry?`，`tab_id?`，`steps`（无 `parameters[]`）
  - `TraceStep`：`click` / `fill` / `press` / `select` / `navigate`（`intent`/`page`/`effect` + 语义字段；动作引起的跳转进 `effect`）
  - `RecordStartParams`（含可选 `purpose`）/ `Stop` / `Await`
- Schema：`schema/trace.json`、`trace_step.json`、`tool_record_*_{params,result}.json`

### 修改（在 main 已有文件上扩展）

- [`method.rs`](../crates/bsk-protocol/src/method.rs)：新增 `ToolRecordStart|Stop|Await`；`ToolRecordStart` 的 `is_mutating() == true`（可带 `url` 导航，需受 pending-interrupt 闸）；`Stop`/`Await` 为 false（便于收尾）
- [`tools/mod.rs`](../crates/bsk-protocol/src/tools/mod.rs)、[`dump-schema.rs`](../crates/bsk-protocol/src/bin/dump-schema.rs)：导出注册

### Trace 形态（main 上不存在，本需求引入）

```json
{
  "version": 3,
  "purpose": "这是一个在 iwiki 撰写文档的操作流程。",
  "recorded_at": "...",
  "entry": { "start_url": "https://iwiki.woa.com/dashboard", "site": "iwiki.woa.com" },
  "steps": [
    {
      "id": 1,
      "op": "click",
      "intent": "confirm",
      "target": { "role": "button", "name": "发布", "tag": "button" },
      "summary": "点击「发布」按钮",
      "effect": { "navigated_to": "https://iwiki.woa.com/p/...", "url_pattern_after": "https://iwiki.woa.com/p/*" }
    }
  ]
}
```

**质量门禁（捕获层）：**

| 应收 | 应拒 |
|------|------|
| 有可读名称的交互控件（按钮/链接/自定义 btn 等） | `{ "tag": "div" }` / 「点击div」 |
| FillSession 最终值 + summary | 逐键；联想建议 click |
| 密码 `***` + `redacted` | `@eN`、深路径 CSS、standalone `wait_for_navigation` |

---

## 4. 扩展（`apps/extension`）— vs `origin/main`

### 新增核心文件（main 上无对应实现）

| 文件 | 职责 |
|------|------|
| `lib/describe-target.ts` | 可见名 / role / 可点击解析；`isMeaningfulClickTarget` |
| `content/record-capture.ts` | DOM 捕获：FillSession、忽略 suggestion click、语义 emit |
| `lib/record-bridge.ts` | content ↔ background 消息协议 |
| `lib/recording-step-buffer.ts` | payload → DraftTraceStep；动作引起的跳转写草稿 `navigated_to`，否则 `navigate` |
| `lib/url-pattern.ts` | URL canonicalize / pattern / page role |
| `lib/trace-reducer.ts` | Draft → v3 textbook（intent/page/effect；无 parameters 抽取） |
| `tools/record.ts` | `record_start/stop/await`、finishPromise、导航 re-arm |
| `content/RecordOverlay.tsx` | 录制中 + 结束 |

### 修改（在 main 已有入口上接线）

- `dispatcher.ts`：处理 `tool.record_*`
- `background.ts`：挂 step / finish / navigation / query / tab listeners；`webNavigation` 权限
- `content.ts` + `overlay-controller.ts`：录制面板；录制时隐藏控制遮罩
- `session.ts`：`session_stop` 清理进行中的 recording
- `transport/types.ts`：TS 侧 Trace v2 类型
- `wxt.config.ts`：增加 `webNavigation`

### 录制启动约束

Agent Window 在 main 上即默认 `about:blank`，content script 无法注入。  
本需求的 `record_start` 在受限 URL 上返回明确错误，要求：

```bash
bsk record start --purpose "..." --url https://...
```

### UI / i18n

- **新增**键：`recordOverlay.recording` / `finish`（en / zh）

---

## 5. CLI（`bsk-cli`）— vs `origin/main`

### 新增

- `bsk record start [--purpose] [--url] [--output trace.json] [--tab-id]`
  - `session.start` → `tool.record_start` → **阻塞** `tool.record_await` → 写文件 → `session.stop`
- `bsk record stop [--output trace.json]`：终端兜底结束
- `cli/record_state.rs` + `paths::record_session_path()`：`~/.bsk/record-session.json`

### 修改

- `cli/mod.rs` / `main.rs`：注册子命令
- `daemon/ipc.rs`：转发 `ToolRecord*`
- `cli/session.rs`：抽出可复用的 `start_session` / `stop_session`（供 record 复用）
- `skill/SKILL.md`（仓库根与 `crates/bsk-cli/skill`）：**新增**录制用法段落

---

## 6. 测试与验证

### 单测

- `bsk-protocol`：`tools::record` round-trip / purpose 序列化
- `bsk`：`cli::record` / `record_state`
- Extension Vitest：`describe-target`、`recording-step-buffer`、`record-capture`、`overlay-controller`

### 手工验收（相对 main：全新路径）

1. 基于本分支构建 CLI + 扩展并刷新扩展；`bsk status` 已连接  
2. `bsk record start --purpose "demo" --url https://...`  
3. UI 出现录制中 + 结束；页面可交互  
4. 操作后点「结束」→ `./trace.json`：`version === 2`；有 `target`/`summary`；无 `@eN`；无「点击div」  

---

## 7. 文件清单（相对 `origin/main`）

### 新增

```
crates/bsk-protocol/src/tools/record.rs
crates/bsk-protocol/schema/trace.json
crates/bsk-protocol/schema/trace_step.json
crates/bsk-protocol/schema/tool_record_*.json
apps/extension/src/lib/describe-target.ts
apps/extension/src/lib/record-bridge.ts
apps/extension/src/lib/recording-step-buffer.ts
apps/extension/src/lib/trace-reducer.ts
apps/extension/src/lib/__tests__/describe-target.test.ts
apps/extension/src/lib/__tests__/recording-step-buffer.test.ts
apps/extension/src/content/record-capture.ts
apps/extension/src/content/RecordOverlay.tsx
apps/extension/src/content/__tests__/record-capture.test.ts
apps/extension/src/tools/record.ts
crates/bsk-cli/src/cli/record.rs
crates/bsk-cli/src/cli/record_state.rs
docs/semantic-record.md
docs/semantic-record-change-review.md   # 本文
```

### 修改（main 已有文件）

```
crates/bsk-protocol/src/method.rs
crates/bsk-protocol/src/tools/mod.rs
crates/bsk-protocol/src/bin/dump-schema.rs
apps/extension/src/tools/dispatcher.ts
apps/extension/src/entrypoints/{background,content}.ts
apps/extension/src/content/overlay-controller.ts
apps/extension/src/content/__tests__/overlay-controller.test.ts
apps/extension/src/tools/session.ts
apps/extension/src/transport/types.ts
apps/extension/wxt.config.ts
crates/bsk-cli/src/{main.rs,cli/mod.rs,cli/session.rs,daemon/ipc.rs,daemon/paths.rs}
skill/SKILL.md
crates/bsk-cli/skill/SKILL.md
packages/i18n/src/locales/{en-US,zh-CN}/extension.json
```

### 请勿合入

- 仓库根目录本地产物 [`trace.json`](../trace.json)（用户录制结果）

---

## 8. 风险与后续

| 风险 | 说明 | 建议 |
|------|------|------|
| 自定义控件漏录 / 误录 | 依赖可见名 + clickable 启发式 | 用真实内网页回归；按需调整规则 |
| `about:blank` 启动失败 | 无 `--url` 必失败 | 错误文案已提示；可考虑后续默认起跳页 |
| 菜单项不在 a11y 树 | 如 iwiki「文档 C+D」 | 录制尽量记有 name 的项；事后执行仍靠既有 snapshot/@eN |
| 教材质量 vs 执行 | 本需求不保证自动跑通 | 执行完全复用现有工具；由 Agent/人读 trace 后自行驱动 |

---

## 9. Review 关注问题

1. 相对 main，是否 **仅** 增加了录制相关代码，没有夹带 replay/执行引擎？  
2. Trace v2 是否足够作为 LLM 教材（有 name/summary），噪声是否可接受？  
3. `isMeaningfulClickTarget` 是否过严或过松？  
4. `record_await` 长超时与 daemon IPC 是否匹配？  
5. `record_start` 标为 mutating、`stop`/`await` 标为 non-mutating 是否合理？  
6. 文档是否写清：**交付 = trace.json；执行 = 复用既有 bsk 能力**？
---

## 10. 建议评审命令（对照远程 main）

```bash
git fetch origin
git checkout new_record

# 工作区相对 origin/main 的变更一览（含未跟踪新文件）
git status
git diff origin/main --stat
git diff origin/main -- crates/bsk-protocol/src/method.rs crates/bsk-cli/src/main.rs

# 新增文件直接阅读（相对 main 为从零新增）
less crates/bsk-protocol/src/tools/record.rs
less apps/extension/src/lib/describe-target.ts
less apps/extension/src/content/record-capture.ts
less apps/extension/src/tools/record.ts
less crates/bsk-cli/src/cli/record.rs

cargo test -p bsk-protocol --lib tools::record
cargo test -p bsk --lib record
cd apps/extension && pnpm exec vitest run \
  src/lib/__tests__/describe-target.test.ts \
  src/lib/__tests__/recording-step-buffer.test.ts \
  src/content/__tests__/record-capture.test.ts
```
