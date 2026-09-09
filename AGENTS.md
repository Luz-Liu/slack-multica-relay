# Slack → Multica Relay 协作规则

## Multica 操作入口

- Multica 的工作区、智能体、项目、任务、运行记录、Skills 和配置管理必须使用 `multica` CLI；不要用浏览器点击或填表代替 CLI。
- 先执行 `rtk proxy multica --help` 和具体子命令的 `--help`，以当前安装版本为准。CLI 缺失、认证失败或能力不足时先定位原因并报告；只有用户明确要求浏览器操作时才切换。
- 命令统一经 `rtk` 执行；Multica 使用 `rtk proxy multica` 保留原始 JSON。结构化读取显式加 `--output json`，不要解析表格中的截断 ID。
- 此处命令是操作说明，不授权线上修改。按当前用户请求限定写入对象与字段，写前读取现状、写后按同一 ID 回读；结果不明时先查现状，不盲目重复写入。

## 发现当前服务与工作区

```bash
rtk proxy multica version
rtk proxy multica config show
rtk proxy multica workspace get --output json
rtk proxy multica workspace list --output json
```

- `config show` 查看当前配置的服务地址和默认工作区；`workspace get` 不带参数时读取当前默认工作区。核对返回的 `id`、`name`、`slug`，不要从当前目录推断工作区。
- 同时检查本次调用是否设置了 `--profile`、`--server-url`、`--workspace-id` 或 `MULTICA_SERVER_URL`、`MULTICA_WORKSPACE_ID` 覆盖值；使用命名 profile 时，后续命令都带同一个 `--profile`。
- 本项目常用服务为 `https://multica.devops.moego.dev`，工作区为 `GRM`；它们是定位线索，具体目标以用户要求和实时查询为准。不要为了单次任务执行 `workspace switch` 或 `config set` 改变全局默认值。
- 从列表取得完整工作区 UUID 后，显式限定后续调用；下方所有 `<...>` 都须替换为已查询的值：

```bash
mc_server='https://multica.devops.moego.dev'
mc_workspace='<workspace-id>'
mc() { rtk proxy multica --server-url "$mc_server" --workspace-id "$mc_workspace" "$@"; }
mc workspace get "$mc_workspace" --output json
```

若使用命名 profile，在 `mc` 函数的 `multica` 后补上 `--profile '<profile>'`，不要混用不同 profile 的身份或配置。

## 发现对象与读取上下文

先 list，再 get；按名称匹配后核对完整 ID、工作区和关联对象。Agent 名称字段是 `name`，Project 名称字段是 `title`。本项目常用 Agent 为 `Slack Task Router (Codex)`，Project 为 `Slack Task Router 任务看板`；不要把旧会话里的 ID 当作当前配置。

| 目的 | 命令（使用上面的 `mc`） |
| --- | --- |
| 智能体列表 / 详情 | `mc agent list --output json` / `mc agent get '<agent-id>' --output json` |
| 项目列表 / 详情 | `mc project list --output json` / `mc project get '<project-id>' --output json` |
| 项目内任务 | `mc issue list --project '<project-id>' --limit 50 --offset 0 --output json` |
| 按智能体查任务 | `mc issue list --assignee-id '<agent-id>' --output json` |
| 搜索任务 / 读取详情 | `mc issue search '<关键词>' --output json` / `mc issue get '<issue-id>' --output json` |
| 智能体运行记录 | `mc agent tasks '<agent-id>' --output json` |
| 某任务的运行历史 / 当前运行 | `mc issue runs '<issue-id>' --output json` / `mc issue runs '<issue-id>' --active --output json` |
| 某次运行的消息 | `mc issue run-messages '<run-id>' --issue '<issue-id>' --output json` |
| 工作区 Skills / Skill 内容 | `mc skill list --output json` / `mc skill get '<skill-id>' --with-content --output json` |
| 智能体绑定的 Skills | `mc agent skills list '<agent-id>' --output json` |
| 运行时列表 | `mc runtime list --output json` |
| 自动化列表 / 详情 | `mc autopilot list --output json` / `mc autopilot get '<autopilot-id>' --output json` |

- UI 的任务卡是 **issue**；`agent tasks` 和 `issue runs` 是执行记录 **run**。`run-messages` 接收 run ID，不是 issue ID；不要猜测 `multica task list`。
- `issue list` JSON 包含 `issues`、`has_more`、`limit`、`offset`、`total`；需要完整列表时逐页递增 offset，直到 `has_more=false`。每页上限 100；不要把第一页当作全部。
- `issue search` 默认不含已完成/取消项，需要时加 `--include-closed`。数字或工单式查询可能按编号命中无关任务，必须再核对标题与所属项目。
- 只读取当前任务需要的正文、运行消息和 Skill 内容。配置、凭据及原始消息不得进入提交、PR 或无关日志；不要为普通查询使用 `autopilot get --show-secrets`。

## 调整智能体

1. `agent get` 锁定 Agent ID、工作区、当前 `instructions` 和待改字段；修改前重新读取，现状已变化时先重算差异。
2. 先准备完整候选内容并核对差异，再执行 `agent update`，仅传本次要修改的字段。`--instructions` 替换整份 prompt，不是追加；保留现有未涉及的规则。
3. 更新后再次 `agent get`，核对目标字段与候选值一致；Skill 绑定改动用 `agent skills list` 回读。配置保存不等于运行或 Slack 回复已经完成，不为验证配置擅自触发任务。

常用参数（使用前读取 `mc agent update --help`）：

| 调整内容 | 参数 |
| --- | --- |
| 名称 / 描述 / 完整 Prompt | `--name` / `--description` / `--instructions` |
| 模型 / 思考强度 / 服务档位 | `--model` / `--thinking-level` / `--service-tier` |
| 运行时 / 并发上限 | `--runtime-id` / `--max-concurrent-tasks` |

模型、思考强度和服务档位须与目标 runtime 支持能力一致；不能照搬其他 Agent 的配置或凭空填写枚举值。环境变量与 MCP 通过 `mc agent env --help`、`mc agent mcp --help`、`mc workspace mcp --help` 发现对应操作，不把凭据塞进 instructions。

- 新增 Skill：`mc agent skills add '<agent-id>' --skill-ids '<skill-id-1>,<skill-id-2>' --output json`。
- 整组替换：`mc agent skills set '<agent-id>' --skill-ids '<完整目标集合>' --output json`；只有确实需要替换时才使用，避免丢失原绑定。
- 当前 CLI 的 Prompt 参数是 `--instructions`，没有 `--instructions-file`。多行候选先写入仓库外的 UTF-8 文件，用参数数组传入 CLI，禁止将正文拼成 shell 命令。以下示例仅在修改已获授权且候选已核对后执行；文件不得包含凭据：

```bash
rtk proxy python3 - "$mc_server" "$mc_workspace" '<agent-id>' '<候选文件绝对路径>' <<'PY'
import json, subprocess, sys
from pathlib import Path
server, workspace, agent, file = sys.argv[1:]
prompt = Path(file).read_text(encoding="utf-8")
cli = ["multica", "--server-url", server, "--workspace-id", workspace]
# 使用命名 profile 时，也在 cli 参数数组中加入同一个 --profile。
subprocess.run(cli + ["agent", "update", agent, "--instructions", prompt],
               check=True, capture_output=True, text=True)
saved = json.loads(subprocess.check_output(
    cli + ["agent", "get", agent, "--output", "json"], text=True))
assert saved["instructions"] == prompt, "回读 Prompt 与候选不一致"
print("Prompt 已保存并回读一致")
PY
```

## 本项目资料与验证

- 链路和验证命令读 `README.md`；配置及部署读 `SETUP-GUIDE.zh-CN.md`；恢复与幂等边界读 `REVIEW.md`。
- `AGENT-PROMPT.md` 是仓库的 Prompt 真源。调整 Prompt 时先对照线上 `instructions`，保留线上新增且仍有效的规则；文件变更不会自动同步到 Multica，发布必须显式使用 CLI 并回读。
- 安装依赖：`rtk proxy pnpm install --frozen-lockfile`；业务代码变更：`rtk proxy pnpm test`、`rtk proxy pnpm lint`。仅修改操作文档时核对 CLI 帮助、相关只读命令和 `rtk git diff --check`，不为文档验证执行线上写入。
