# 证据记录与门槛

脚本只依赖 Python 3.9+ 标准库。设定 SKILL 为本技能绝对路径、RUN 为全新证据目录。以下占位符须替换为当轮实际值，不要把示例 ID 传给 Bsk。

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

serve 放入托管后台任务，保留输出。init 递归 --help，发现叶命令、枚举 action 以及 navigate 本体；生成 inventory.json、help/、run.json、plan.json、results.json 及本轮 fixtures。不覆写历史目录。--binary 指 wrapper 真正调用的编译产物；不能仅 hash wrapper 宣称构建固定。

每条操作单独记录：

```bash
python3 "$SKILL/scripts/release_audit.py" exec --run "$RUN" --case LIFE-SESSION -- \
  session start --browser ACTUAL_BROWSER --json
# 读取返回路径的 stdout.txt，取得真实 session_id 后才执行下一条。
python3 "$SKILL/scripts/release_audit.py" exec --run "$RUN" --case CAROUSEL-LOCAL -- \
  navigate http://127.0.0.1:FREE_PORT/carousel --session ACTUAL_SESSION --json
python3 "$SKILL/scripts/release_audit.py" exec --run "$RUN" --case CAROUSEL-LOCAL -- \
  cooperate sync --session ACTUAL_SESSION --json
# 从上一步顶层字段取真实 CTX、OBS，再 evaluate；不串接猜值。
```

recorder 不注入 session/receipt、不重试、不修正 Bsk 参数。stdout/stderr/argv/起止时间/退出码/timeout/构建哈希保存在 commands/UUID。后台长命令输出实时落文件；未结束命令会阻塞 gate。外层 --timeout 默认60秒，可按有界任务调整；命中外层 timeout 不能算业务预期超时。

命令 case ID 使用双下划线分隔命令路径，例如 `CMD-navigate__back`；带连字符的别名仍是 `CMD-navigate-back`。从 plan.json 读取实际 ID，不自行将空格替换成连字符，以免把子命令与别名合并。

admin 命令明确加 `--lane admin`，使用相同 raw binary、RUN/admin-runtime。stdio MCP 可将协议 NDJSON 输入放 RUN 内，通过 `--stdin-file inputs/mcp.ndjson -- mcp` 送入；若请求依赖上一个响应，使用 `exec --interactive --timeout 900 -- mcp` 放入托管 PTY：从返回的 stdout 路径读响应，再向该 PTY 写下一行 JSON-RPC；输入同步保存在 stdin.txt。结束发送 EOF，使 Bsk 正常退出并结算记录，不用强杀制造成功。每个响应 ID、结果/错误均须断言。不能凭 tools/list 给工具全打勾。输入脚本/MCP驱动不得调用其他浏览器后端。

## 每项结果

结果 JSON 写在 RUN 下，records 是 recorder 返回的真实 UUID；JSON pointer 路径以当轮输出为准。每条 passed 至少有可追溯 Bsk 记录、原始输出断言和具体业务 oracle。产物路径必须 RUN 内。

```json
{
  "id": "CAROUSEL-LOCAL",
  "status": "passed",
  "records": ["ACTUAL_RECORD_UUID"],
  "oracle_summary": "填写三次求值、真实轮播变化、表单保存事件的实际检查结果及证据，不复制此占位文本。",
  "checks": [
    {"record":"ACTUAL_RECORD_UUID","pointer":"/exit_code","op":"eq","value":0},
    {"record":"ACTUAL_RECORD_UUID","pointer":"/json/ACTUAL_RESULT_FIELD","op":"eq","value":"ACTUAL_EXPECTED_VALUE"},
    {"artifact":"artifacts/carousel.png","op":"file_nonempty"}
  ]
}
```

这只是结构示例，单次记录/截图不足以通过 carousel 场景全部步骤。需要三个 evaluate 的内层结果断言、两帧内容/时间差证据、保存事件 exact value/count；把所有相关 UUID 加进 records。

```bash
python3 "$SKILL/scripts/release_audit.py" result --run "$RUN" --file "$RUN/results/CASE.json"
python3 "$SKILL/scripts/release_audit.py" gate --run "$RUN"
```

允许 status 为 failed/blocked/unverified；它们都阻止放行。结果追加不覆盖；一次失败后的复测在新轮次，旧记录仍保留。CMD-* 可以引用已完成业务场景的真实记录及断言，不必为命令统计重发有副作用操作。

checks 支持 record 的 `/json/...`、`/stdout`、`/stderr`、`/exit_code`、`/argv`，或 artifact JSON pointer；op 为 eq/ne/contains/not_contains/regex/len_eq/gt/is_string，artifact 另支持 file_nonempty/sha256。eq 严格类型，true 不等于1。视觉正确性必须实际看图/解码核验，并在 oracle_summary 和报告中指出看到的内容，file_nonempty 只证明存在。

部分场景有 `required_command_counts`，gate要求达到指定数量的不同实际命令记录（如4次wheel、8次前后evaluate），同一UUID重复填入会拒绝。次数不能代替业务核验；动态页的即时/延迟、方向、容器和持续更新检查见 [dynamic-pages.md](dynamic-pages.md)。

## 预期负例与中间状态

- negative 场景必须断言真实错误 code；除本地参数/文件/等待等例外，还检查 effect_state 和未执行的业务事件。不能把任意非零都算负例通过。负例不提供成功命令覆盖。
- NEG-WAIT-ELEMENT 允许 exit0，但必须断言实际 satisfied:false（按返回 schema 选 `/json/satisfied` 或 `/json/data/satisfied`）；其他正例等待必须断言 true。
- 对 allow_dialog_pending 的对话框场景，结果可加 `intermediate_records:[UUID]`；对应原始记录必须确为 code:dialog_pending 并有此断言。后续决策/operation await 的 terminal state、业务结果与once计数仍要明确检查。其他失败不能包装为 intermediate。
- 意外失败即使后续成功仍在全局 ledger 阻止放行；故意的负例只能归预声明 negative case，不得在失败后改计划将其“预期化”。

## gate 的边界

gate 核验固定场景/动态命令完整性、哈希、记录身份、断言、退出状态、未结束/意外失败、required 参数变体。它不能证明人工写的“看到了轮播”是真的，也不能代替 Agent 检查业务含义。报告必须区分机械门槛和业务核验。禁止手改 ledger、场景/分母、错误记录以获取绿色结果；报告必须包含所有失败/重试/阻塞。

MCP 每工具和组合场景内部的细项由 Agent 根据当前 schema 展开子表并逐项断言。发现未覆盖细项即不满足对应场景，不因外层脚本能跑而通过。
