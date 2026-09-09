# Slack → Multica Relay

在获准频道中 @真人或 User Group，把请求交给 Multica 的专用 Agent，执行环境可以是本地 Codex。适配 Vercel Functions 与 EdgeOne Cloud Functions，共用同一套处理逻辑。

## 链路

`Slack → 签名与准入校验 → QStash 持久化 → HTTP 200 → 消费函数 → Multica Issue → Agent/Runtime → Slack 回复`

- 只处理当前消息明确 mention 的事件。Team 必填；频道和发送者支持白名单（可设为 `all`）及黑名单，黑名单优先。Bot、编辑/删除、普通讨论不触发。
- 入站只等待 QStash 接收；队列负责后台投递及3次重试，耗尽后在其失败队列查看/重放。
- 每个 Slack thread 通过普通 Issue API 创建独立任务卡，不经过 Autopilot 同标题60秒去重。
- thread scope 包含 Workspace、Project、稳定的路由标识；默认不同 Agent/Team 不采用彼此的映射。
- 同 thread 后续消息追加评论。QStash 按 thread 限并发，Redis 锁与消息状态处理重投。
- 标题使用消息摘要与稳定的线程短标识；描述和后续评论分为原文引用、来源及 JSON 上下文，附件仅保留定位字段。
- 描述首行的 `relay-thread` 标记和 `relay-payload:v1` 数据区块用于 KV 映射过期后的恢复，请勿删除或修改。读取兼容历史裸 JSON；损坏的数据会停止恢复，不自动重新建卡。
- 写请求结果不明时先查回读；查不到则保留 ambiguous 错误，不盲目再次 POST。需要人工核对/重放，不承诺 exactly-once。
- `comment_persisted` 只表示评论保存，实际执行和原 thread 回复要分别验收。
- Prompt 真源为 [AGENT-PROMPT.md](AGENT-PROMPT.md)，需要明确同步到 Multica Agent instructions。Relay 不调用 Codex 或修改 Multica 源码。

## 本地验证

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
```

配置与两平台部署见 [搭建手册](SETUP-GUIDE.zh-CN.md)，契约边界见 [审查记录](REVIEW.md)。

## 状态与日志

日志记录关联标识、耗时和有限错误码。正文保存在队列和 Multica；Redis 保存线程/消息状态，不存 pending 正文。状态保留90天。内容级调试日志尚未启用，凭据不进入日志。

| 接口结果                | 含义                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| 入站 accepted / HTTP200 | QStash 已接收，不代表 Agent 完成                                       |
| 入站 ignored / HTTP200  | 不满足触发范围                                                         |
| 入站503                 | 收件未确认，交给 Slack 重试                                            |
| 消费 created            | Issue 已创建或从回读恢复                                               |
| 消费 comment_persisted  | 后续评论已保存                                                         |
| 消费 duplicate          | 已处理的消息                                                           |
| 消费503                 | 保留队列重试/DLQ责任，原因包括 timeout、thread*lock_busy、ambiguous*\* |

`GET /api/health` 仅证明函数可响应。消费有45秒整体预算，部署函数上限60秒；入站发布请求超时2秒。平台冷启动、网络延迟与配额仍须实测。

## 迁移到 Multica Team

新任务设置 `MULTICA_ASSIGNEE_TYPE=squad`、`MULTICA_ASSIGNEE_ID=<Team UUID>`。Team Leader 负责分流，成员不会自动全部执行。未设置新参数时继续兼容 `MULTICA_AGENT_ID`。

已有部署迁移必须将 `MULTICA_THREAD_SCOPE_ID` 固定为原 Agent ID，长期保留；消费者 URL、Redis、Workspace 和 Project 不变。这样锁、消息状态、描述标记和标题标识保持兼容。过渡期可设置 `MULTICA_LEGACY_AGENT_ID=<原 Agent ID>`，只允许采用该旧归属，不能填其他 Agent。

先发布兼容代码，再配置 Team。按原 scope marker 核验历史任务，以 `multica issue assign <id> --to-id <Team UUID> --no-start` 迁移空闲任务；指派可能中断正在运行的任务，因此活动任务应完成后再迁移。不得改写原描述 marker 或清空 Redis。切换后等待旧请求结束并补查遗漏任务。过渡期旧任务仍可由原 Agent 处理；完成归属核验后可以移除 LEGACY 参数。旧版本回滚时也必须同时恢复任务归属，不能只回滚代码。

Team 指令只注入 Leader。子任务仍需主动结果交接和回复去重；`in_review` 保留人工验收，不能仅依赖 run completed 自动回复 Slack。Token、签名密钥保留 Secret；上述类型和 ID 使用可查看的 Config。

Team 模式不将旧 Agent 的配置快照当作实际执行模型：relay 的 `slack_reply_context` 标记为 unavailable、agentId 为 null；最终回复 Skill 应从实际运行记录获取模型与统计。
