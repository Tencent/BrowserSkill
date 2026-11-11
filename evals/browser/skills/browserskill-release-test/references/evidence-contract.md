# 证据记录、Benchmark 统计与放行门槛

脚本只依赖 Python 3.9+ 标准库。设定 `SKILL` 为本技能绝对路径、`RUN` 为全新证据目录。以下占位符须替换为当轮实际值，不要把示例 ID 传给 Bsk。

原始合成资源的哈希见 [fixture-manifest.json](fixture-manifest.json)，用于核对随技能交付的 assets；每轮端口替换及追加合成文件后，另保存本轮实际 fixture 哈希，不能把旧服务器事件或旧测试结果当作新证据。

`gate.json` 中的 `release_ready` 只表示本套全量证据检查是否通过，不注册为 PR required check，也不代表维护者的合并或发布审批。局部自测保留完整分母并报告未覆盖项，不能通过删除计划获取通过结果。

## 初始化与执行

```bash
python3 "$SKILL/scripts/release_audit.py" init \
  --out "$RUN" --bsk /absolute/path/bsk-test-wrapper \
  --binary /absolute/path/actual-compiled-bsk \
  --browser ACTUAL_BROWSER --candidate CANDIDATE_FULL_SHA --port FREE_PORT
python3 "$SKILL/scripts/serve.py" --root "$RUN/fixtures" --port FREE_PORT
```

`serve` 放入托管后台任务，保留输出。`init` 递归 `--help`（含探测实验命令树 `bsk recipe --help`），发现叶命令、枚举 action 以及 `navigate` 本体；生成 `inventory.json`、`help/`、`run.json`、`plan.json`、`results.json` 及本轮 fixtures（含 `/plan-recipe-lab`、`/video-portal`、`/forum-hub` 等）。不覆写历史目录。`--binary` 指 wrapper 真正调用的编译产物；不能仅 hash wrapper 宣称构建固定。

每条操作单独记录，`exec` 默认开启 `BSK_RECIPES=1`（如需测试未开启环境变量的负例，可传 `--env BSK_RECIPES=0`）：

```bash
python3 "$SKILL/scripts/release_audit.py" exec --run "$RUN" --case LIFE-SESSION -- \
  session start --browser ACTUAL_BROWSER --json
# 读取返回路径的 stdout.txt，取得真实 session_id 后才执行下一条。
python3 "$SKILL/scripts/release_audit.py" exec --run "$RUN" --case PLAN-BATCH-FORM -- \
  navigate http://127.0.0.1:FREE_PORT/plan-recipe-lab --session ACTUAL_SESSION --json
python3 "$SKILL/scripts/release_audit.py" exec --run "$RUN" --case PLAN-BATCH-FORM -- \
  cooperate sync --session ACTUAL_SESSION --json
# 从上一步顶层字段取真实 CTX，再用单次 bsk plan 批量提交多步动作：
python3 "$SKILL/scripts/release_audit.py" exec --run "$RUN" --case PLAN-BATCH-FORM -- \
  plan --session ACTUAL_SESSION --context ACTUAL_CTX --until-visible '#plan-summary' \
  --steps '[{"action":"fill","ref":"@e1","value":"林晓"},{"action":"select","ref":"@e2","values":["ZJ"]},{"action":"wait-for-element","selector":"#city option[value=HZ]","state":"attached"},{"action":"select","ref":"@e3","values":["HZ"]},{"action":"click","ref":"@e5"},{"action":"click","ref":"@e6"}]' --json
```

recorder 不注入 session/receipt、不重试、不修正 Bsk 参数。`stdout`/`stderr`/`argv`/起止时间/墙钟耗时（`elapsed_ms`）/退出码/`timeout`/构建哈希以及自动提取的 Benchmark 指标（`metrics`：`execution_mode`、`interaction_turns`、`actions_executed`、`rpc_calls`、`browser_calls`、`observation_kind`、`observation_reused`、`vom_chars`）保存在 `commands/<UUID>/meta.json`。后台长命令输出实时落文件；未结束命令会阻塞 gate。

命令 case ID 使用双下划线分隔命令路径，例如 `CMD-navigate__back`、`CMD-recipe__run`；带连字符的别名仍是 `CMD-navigate-back`。从 `plan.json` 读取实际 ID，不自行将空格替换成连字符。

admin 命令明确加 `--lane admin`，使用相同 raw binary、`RUN/admin-runtime`。stdio MCP 可将协议 NDJSON 输入放 RUN 内，通过 `--stdin-file inputs/mcp.ndjson -- mcp` 送入，或使用 `exec --interactive --timeout 900 -- mcp` 放入托管 PTY。

## 每项结果与放行检查

结果 JSON 写在 RUN 下，`records` 是 recorder 返回的真实 UUID；JSON pointer 路径以当轮输出为准。每条 passed 至少有可追溯 Bsk 记录、原始输出断言和具体业务 oracle。产物路径必须在 RUN 内。

```json
{
  "id": "PLAN-BATCH-FORM",
  "status": "passed",
  "records": ["ACTUAL_SYNC_UUID", "ACTUAL_PLAN_UUID", "ACTUAL_READ_UUID"],
  "oracle_summary": "填写单次 plan 完成 6 步级联表单、返回 post.context_id、服务端 plan-applied 事件精确匹配的实际检查结果。",
  "checks": [
    {"record": "ACTUAL_PLAN_UUID", "pointer": "/exit_code", "op": "eq", "value": 0},
    {"record": "ACTUAL_PLAN_UUID", "pointer": "/json/ok", "op": "eq", "value": true},
    {"record": "ACTUAL_PLAN_UUID", "pointer": "/json/completed", "op": "eq", "value": 6}
  ]
}
```

登记结果并运行放行与 Benchmark 计算：

```bash
python3 "$SKILL/scripts/release_audit.py" result --run "$RUN" --file "$RUN/results/CASE.json"
python3 "$SKILL/scripts/release_audit.py" gate --run "$RUN"
```

## Benchmark 报告与跨轮次聚合

`gate` 运行时会自动计算本轮所有场景与命令的 Benchmark 数据，并写出：
- `$RUN/benchmark.json`：结构化 Benchmark 数据（含 `summary`、`execution_modes`、`page_types`、`commands`、`cases`）。
- `$RUN/benchmark.md`：可读 Markdown 报表（含总成功率、总交互轮次、总动作数、轮次压缩比 `actions/turn`、`single_action` vs `step` vs `plan` vs `recipe` 效率与耗时对比、按页面类型统计、各工作流明细）。
- `$RUN/gate.json`：内嵌 `benchmark_summary` 与 `execution_modes`。

也可单独调用 `benchmark` 子命令生成单轮报告或**跨多轮运行（Multi-Run）聚合 Benchmark**：

```bash
# 单轮重新生成或导出 Benchmark
python3 "$SKILL/scripts/release_audit.py" benchmark --run "$RUN" \
  --out "$RUN/benchmark.json" --markdown "$RUN/benchmark.md"

# 跨多轮运行聚合成功率、平均交互轮次、P50/P95 耗时分布
python3 "$SKILL/scripts/release_audit.py" benchmark \
  --run "$RUN_1" "$RUN_2" "$RUN_3" \
  --out evals/browser/results/benchmark-multi.json \
  --markdown evals/browser/results/benchmark-multi.md

# 或直接扫描包含多个 run 子目录的父目录
python3 "$SKILL/scripts/release_audit.py" benchmark \
  --runs-dir evals/browser/results \
  --out evals/browser/results/benchmark-multi.json \
  --markdown evals/browser/results/benchmark-multi.md
```

## 预期负例与中间状态

- 普通 `negative` 场景必须断言真实错误 `/json/code`；除 `check_effect: false` 的本地参数/文件/等待等例外，还必须检查 `/json/data/effect_state` 和未执行的业务事件。
- `allow_plan_stopped: true` 的 `bsk plan` 负例场景：支持断言 `/json/stopped/error/code`、`/json/stopped/reason` 或 `/stderr`（本地参数拒绝），并在需要检查效果状态时断言 `/json/stopped/effect_state`。
- `allow_recipe_handoff: true` / `allow_recipe_refusal: true` 的 `bsk recipe` 负例场景：支持断言 `/json/status`（`handoff` 或 `refused`）、`/json/reason` 或 `/json/saved`（`false`）。
- 在 `negative` 场景中作为前置准备且成功执行的命令（`exit_code == 0` 且无语义失败）可正常计入命令覆盖，但失败记录本身只归属已声明的负例。
- `NEG-WAIT-ELEMENT` 允许 `exit 0`，但必须断言实际 `satisfied:false`。
- 对 `allow_dialog_pending` 的对话框场景，结果可加 `intermediate_records:[UUID]`；对应原始记录必须确为 `code:dialog_pending` 并有此断言。

## gate 的边界

gate 核验固定场景/动态命令完整性、哈希、记录身份、断言、退出状态、未结束/意外失败、required 参数变体，并自动产出客观耗时与轮次统计。它不能代替 Agent 检查业务含义与视觉截图内容。禁止手改 ledger、场景/分母、错误记录以获取绿色结果；报告必须包含所有失败/重试/阻塞与真实 Benchmark 指标。
