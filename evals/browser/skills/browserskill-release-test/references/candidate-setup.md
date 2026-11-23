# 候选选择、构建与隔离

## PR 自测默认当前 HEAD

这套 Skill 推荐在较大改动提交 PR 前运行，但不是提交或合并 PR 的强制要求，不注册为 required CI check。运行后如实报告覆盖与失败；只有全量证据满足要求才称全量通过。缺少人工参与或公网不可访问时，记录阻塞，不把它算作已通过，也不因此声称项目禁止提交 PR。

1. 在贡献者的目标 checkout 检查 remote、分支、工作区状态及 AGENTS 指令。使用 `git rev-parse HEAD` 固定当前分支的完整 commit SHA。PR 自测应包含待提交改动，不能只测试不含改动的 main。若改动尚未提交，先保存可复查的 diff/内容哈希并标记 dirty；干净 HEAD 的报告不能替代未提交代码的验证，也不能替贡献者自动提交其他改动。
2. 发版或明确要求 main 时，选择指定 release commit，或先 `git fetch origin main` 再固定当时的 `origin/main` SHA。报告区分当前分支自测与发版候选测试。本轮固定候选，不随上游分支移动；候选变化则建立新轮次。
3. 在独立 worktree/checkout 编译固定 SHA，保留原工作区。若用户明确要测未提交代码，将约定的 diff 和相关未跟踪源码复制到隔离源码并核对内容哈希，标记为 SHA + dirty snapshot；不能只 checkout HEAD 后遗漏待测改动。读候选构建说明、package.json、lockfile、扩展配置；使用声明的工具链。当前入口为 `cargo build --locked --release -p bsk` 与 `pnpm ext:build`，协议生成与 workspace 包按当前构建说明执行。构建非零需查清，不能吞错。
4. CLI 与扩展来自同一候选源码。使用本轮独立目录保存 CLI、extension dist 和构建元数据。复制的 manifest 可修改显示名/action 标题，如 `BrowserSkill Test - SHORT_SHA`；使用项目支持的独立端口配置并记录所有打包差异。不能改功能或 guard 使测试通过。
5. 将独立命名的 unpacked 扩展加载到贡献者指定的 Chrome。若加载需人工完成，提供本轮实际目录，确认已加载后再继续。不得覆盖原扩展或借用其他浏览器后端执行测评。是否保留测试安装按用户要求；默认保留用于人工复查，不写死机器路径或 extension ID。
6. 选择空闲 fixture/daemon 端口与独立 `BSK_HOME`。通过当前帮助/配置确认支持方式，禁用自动更新；wrapper 可固定环境，需同时记录 wrapper 与其实际编译二进制的 SHA256。路径由本轮配置传入，不依赖全局 `bsk` 或用户本机预设。
7. 使用候选 `status --json`、`browsers --json` 和 `doctor` 发现实例，显式选择本轮扩展对应 browser。启动自己的 session 后用 `debug capabilities` 核对 build/protocol/扩展；相同版本号不足以证明相同 commit。保存扩展目录文件哈希，并在结束时复核。

从任意 checkout 使用：Skill 根目录是本文件的上级的上级；产品操作规范位于候选仓库的 `crates/bsk-cli/skill/SKILL.md`。阅读该文件及相关 references；不必替换用户已安装技能。

## 结果与配置

将本轮输出放入仓库已忽略的 `evals/browser/results/<unique-run>/`。运行前定义候选源码路径、候选 SHA、Bsk wrapper/raw binary、扩展目录、browser selector 与两个独立端口；在本地 `run.json` 和报告中记录实际值，不把这些本机配置提交到仓库。

证据可能含真实网站内容、浏览器数据与配对 token。只提交 Skill 源码和合成 fixture；PR 如需附证据，先检查并移除敏感字段。不要提交运行目录、生产 HTML、HAR、登录截图或已编译扩展。

## admin lane

`release_audit.py exec --lane admin` 使用同一 actual binary，`BSK_HOME` 强制为 `RUN/admin-runtime`，与浏览器测试 runtime 隔离。独立端口由 daemon 命令明确给出，不重启共享 daemon。

- 在这里实际验证 daemon start/restart/stop/status/logs；server 模式仅 loopback，用临时配对测试 pair/devices/revoke。token 只留本地受控证据，报告脱敏。
- 前台 server 需托管进程，另一步操作配对；确保原命令结束后结算记录。
- `update --check` 与 `install-skill --list` 验证无写入路径，报告明确模式；不能据此称实际更新/安装已通过。需要验证写入时，使用当前支持的独立目标，不覆盖全局 CLI 或技能，也不改 HOME/CODEX_HOME 伪造隔离。
- 新出现的命令需补适用环境和业务断言，不能只执行帮助就计为覆盖。
