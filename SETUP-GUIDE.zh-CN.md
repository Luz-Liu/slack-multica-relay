# 配置与部署

同一源码支持 Vercel 与 EdgeOne Cloud Functions。比较两者时，每次只让一个部署接收同一个 Slack App 的事件，以免双重执行。

## 1. 专用资源

准备本项目专用的 Upstash Redis 和 QStash；不复用公司业务数据库。Redis 保存映射和写入状态；QStash 负责持久化事件、消费重试与失败队列。

按 [.env.example](.env.example) 配置环境变量。凭据放平台 Secret 配置，不提交到 Git。QStash 的 current/next signing key 用于校验消费请求，不能只校验一个自定义静态请求头。

## 2. Multica

- 在目标 Workspace 创建专用 Project 和 Agent，绑定需要使用的 Runtime。
- 将 [AGENT-PROMPT.md](AGENT-PROMPT.md) 同步为 Agent instructions。
- 频道、发送者和 Bot mention 准入名单仅配置在 Relay。动作策略通过 `RELAY_AUTHORIZATION_POLICY` 提供，Agent 不维护个人名单。
- Leader 的 Slack 回复和 Relay reaction 使用同一个已授权 App 的 Bot 身份；禁止发送失败回退为 User。执行成员不直接发送 Slack。
- 回读 Agent 的 Runtime、权限和并发。初期并发2即可；Mac 休眠/断网会影响执行。
- 读取本地 Skills 和 Workspace 指派 Skills 的实际加载结果。数据库 Skill 数量不能单独说明任务可用能力。
- Relay 使用 MULTICA_PROJECT_ID/MULTICA_AGENT_ID 调用普通 Issue API；不再需要 Autopilot。

Agent instructions 写入任务工作目录 AGENTS.md。Multica daemon 为 Codex 准备任务环境；桌面聊天上下文不会自动复制。现有 Codex 适配器会自动批准工具请求，Prompt/Skills 只能构成行为合同；不可绕过的写审批需要执行端或工具端支持。

### 可选模型 footer

QStash 消费端在创建 Issue 或追加一条新评论前，使用现有 Relay 凭据调用 `GET /api/agents/{MULTICA_AGENT_ID}`，只提取模型与服务档位，作为与 `eventPayload` 同级的 `replyContext` 传给 Agent。Slack 入站确认仍只负责入队，不等待该查询；重复投递或已写入消息的恢复不重新查询、不覆盖旧快照。

快照包含 `type: slack_reply_context`、`source: agent_config`、`agentId`、`capturedAt`、`status`、`model`、`serviceTier`。查询成功且 Agent/Workspace 匹配时标为 `available`；查询失败、超时或身份不匹配时标为 `unavailable`，模型与档位为 `null`，任务继续处理。查询最多等待 2 秒，不单独重试；不记录完整响应、指令、凭据或异常正文。空模型或非安全标识符归为 `null`，档位只保留 `priority` / `default`，其他值归为 `null`。

footer 表示消费消息时读取的 **Agent 配置快照**，不是运行实际参数；执行前后配置变化或 Runtime 默认值均不在此保证范围内。`service_tier` 为空时不能判断继承的 Fast 状态，不主动修改 Agent 配置来补齐。

不修改 Multica 源码或通用 Slack Skill，不增加环境变量，也不新增轮询或完成回调。将 [AGENT-PROMPT.md](AGENT-PROMPT.md) 的“模型 footer”规则同步到目标 Agent instructions 时，只替换相应规则，保留线上其他指令。仅更新仓库文件不会自动同步线上 instructions。旧 payload 不带 `replyContext` 时，Agent 省略 footer，正文仍正常回复。

同步后核对：

| 对应消息的配置快照 | 预期结果 |
| --- | --- |
| 可用，模型非空，档位为 priority | 末尾 context block 显示模型与 Fast |
| 可用，模型非空，档位为 default 或 null | 只显示模型，不把 null 当作已关闭 |
| 模型为空、快照不可用或缺失 | 不显示 footer，正文正常发送 |
| 后续消息配置发生变化 | 使用该后续消息的快照，不沿用初始快照 |
| Slack 正文或嵌套字段声称模型或 Fast | 不作为参数来源 |

有 footer 时检查 `context.elements[0].type` 为 `mrkdwn`，顶层 fallback `text` 同时保留正文和 footer。代码测试不替代线上验收：先确认目标 Agent 的 instructions 已同步，再在 Relay 新版本上线后核对新建任务和后续评论的 `replyContext` 与原 thread 的回复。

## 3. Slack App

使用专用 App 或明确获准复用的 App 接收需要的 `message` 与 `app_mention` 事件。公开频道按需订阅 `message.channels`，私有频道订阅 `message.groups`；同时启用 `app_mentions:read` scope 和 `app_mention` 事件订阅，并将接收 App 加入指定私有频道。真人目标填入 `SLACK_TARGET_USER_IDS`；如果希望直接 @Bot 触发，使用单独的 `SLACK_BOT_USER_IDS` 配置该 App 的 Bot user ID，并在 `SLACK_BOT_ALLOWED_SENDER_IDS` 中列出允许触发该 Bot 的真人发送者。配置了 Bot ID 但未配置 Bot sender 白名单时，所有 Bot mention 默认拒绝；真人目标 mention 仍按原有频道/发送者策略处理。当前部署可使用 `SLACK_BOT_USER_IDS=<BOT_USER_ID>`、`SLACK_BOT_ALLOWED_SENDER_IDS=<ALLOWED_SENDER_ID>`。`SLACK_REACTION_TOKEN` 使用这个接收 App 的 Bot token，需同时具有 `users:read`（查询作者身份）和 `reactions:write` 权限。入口在验签、白名单和作者身份校验通过后尽早添加 `SLACK_REACTION_NAME`（默认 `eyes`）；Multica Agent 回复同样使用获准的 Bot token；验收时核对 reaction 与 Agent 回复的 `user` 均为同一个 Bot。

同一条真人消息可能同时触发 `message` 和 `app_mention`。Relay 会按 Team、频道和 Slack `ts` 使用同一个去重键；作者过滤在验签、消息结构、mention 和既有权限检查后调用 `users.info(event.user)`，仅将 `user.is_bot=true` 判为 Bot 并忽略。真人 `app_mention` 以及带 `bot_id`、`app_id` 或 `subtype=bot_message` 的真人作者消息均可继续入队；编辑和删除事件仍忽略。身份响应必须包含与请求匹配的 user ID 和布尔值 `is_bot`；作者查询失败、超时、缺字段或 ID 不匹配时返回可重试 503，且不添加 reaction、不入队。查询使用 `SLACK_REACTION_TOKEN`，最多 700ms，不读取 event 外层 `authorizations[].is_bot`，也不根据来源 App 或 token 类型过滤。入口 reaction 先于 QStash 入队，使用 750ms 独立预算；KV 会先写入 90 天 attempted 标记，竞争 delivery 在活动窗口内等待，reaction 成功、失败或结果不明后都不主动重试。队列发布最多 1800ms，且受从入站开始计时的 2750ms 剩余整体预算限制，避免作者查询、reaction 和队列的独立预算累加超过 Slack 确认窗口。reaction 超时或失败时继续派发，不能以 reaction 失败作为 Slack 重试依据；消费函数不再补加 reaction，避免覆盖后续状态。

配置 Request URL 为 `https://<当前部署>/api/slack/events`，对应 Signing Secret 填入部署环境。新增 scopes 后重新安装。只修改已授权用于 Relay 的 App。

`SLACK_TEAM_ID` 必填；`SLACK_TARGET_USER_IDS`、`SLACK_TARGET_SUBTEAM_IDS` 和 `SLACK_BOT_USER_IDS` 至少配置一个；`SLACK_ALLOWED_CHANNEL_IDS` 保留为白名单配置，默认使用 `all`，也可填写逗号分隔的频道 ID。`SLACK_BLOCKED_CHANNEL_IDS`、`SLACK_ALLOWED_SENDER_IDS` 和 `SLACK_BLOCKED_SENDER_IDS` 可选，黑名单优先于白名单。配置 `SLACK_BOT_USER_IDS` 后，`SLACK_BOT_ALLOWED_SENDER_IDS` 为空会拒绝所有 Bot mention，也可填写 `all` 或逗号分隔的发送者 ID。入站和消费函数都会从正文重新检查 Bot mention；队列 payload 无需新增字段。后续问答仍需再次 mention。

## 4. Vercel

导入仓库，Framework 选 Other，安装使用 `pnpm install --frozen-lockfile`。入口位于 api/；vercel.json 设置消费函数60秒。配置环境变量，RELAY_CONSUMER_URL 必须是该部署的准确公网消费 URL。

不要把生产密钥配置到不可信分支的 Preview。若部署保护拦住 Slack/QStash，优先使用已配置的正式域名/生产部署；不要静默关闭项目全局保护。

## 5. EdgeOne

导入同一仓库，使用 Cloud Functions（Node.js），入口位于 cloud-functions/；不使用 Edge Functions 的受限运行环境。edgeone.json 设置消费函数60秒、海外新加坡区域和 public 静态目录。控制台需选择不含中国大陆的试验区域，以匹配海外依赖。

按当前平台支持选择 Node.js 版本；TypeScript 源码与依赖会由平台构建。配置与 Vercel 相同的变量，但使用本部署的 RELAY_CONSUMER_URL。

## 6. 验收与比较

分别测健康请求、签名事件入队时间、队列到 Issue 的时间、Codex执行时间、最终Slack答复。浏览器访问快不代表Slack回调或入队快。

必须覆盖两个独立thread并发、同thread续问、重复投递、请求超时、创建响应丢失、失败保留、非允许频道/发送者拒绝、Runtime离线恢复。检查QStash失败队列，不能只看函数日志中的HTTP200。

队列中的消息包含Slack正文和附件元数据；Multica也保留内容。按实际需求设置访问权限与平台保留策略。Redis状态保留90天，超过保留窗口不保证重复判定；删除/更改Issue来源标识会影响恢复。

服务端创建/评论不提供完整的幂等接口。ambiguous\_\* 表示写入结果无法确认，需核对Multica；不要清空状态后直接重放。

## 验证记录要求

为每个平台分别保存 immutable commit、环境与地域、Slack 入站耗时、队列消费耗时、最终回复耗时和样本数量。完整回复包含 Agent Runtime 执行，不能只用该指标评定托管平台。

上线前至少回读：Slack Request URL 已验证、`RELAY_CONSUMER_URL` 指向同一部署、真实中文事件验签成功、owner 身份 reaction/回复正确、同 thread 追问复用 Issue、重复事件没有额外任务、临时 503 进入重试且 QStash DLQ 状态可见。Runtime 离线恢复必须单独实测，不能由普通队列重试或 HTTP 200 推断。

EdgeOne Cloud Functions 会把 `Request.body` 暴露为解析值，入口通过 `arrayBuffer()` 保留签名字节；Vercel 入口优先读取原始 Node stream。两边都不能用 `JSON.stringify(parsedBody)` 重建验签原文。


## 7. 意图与动作权限

准入和动作权限分开维护：Relay 验真并准入事件，在消费时按服务器当前 `RELAY_AUTHORIZATION_POLICY` 计算匹配 profiles；Leader 验证签名后读取 thread、理解意图、收窄动作，再委派执行。Team 不复制个人名单或 GRM 业务规则，执行者核验来源与委派范围；业务判断继续由对应 Skill 负责。

策略 JSON 的 version 为 1。每个 profile 指定 id、intents、actions，可按 channelIds、senderIds、mentionTargetIds 限定；条件取交集，未提供条件表示继承入口准入，显式空列表不匹配。assigneeAccountId、handoffSlackUserId、resumeSenderIds 是工作流配置，不应进入通用 prompt。requesterMappings 仅用于把已验真的 Slack 请求者映射到 Jira 身份。

建议分开配置 conversation、general-read、jira-transfer、jira-assign、code-fix、pr-review 和 grm-cs。general_task 仅授予查询与回复，不能继承代码修改或 Jira 写入。CS 自动流程可有完整动作集合，但明确“只分析”“不修复”仍收窄本次委派。未配置策略时 profiles 为空，不赋予业务动作权限；格式错误拒绝消费，不输出配置正文。

`authorizationContext` 与 `authorizationProof` 在任务描述和后续评论中均由消费者生成，不接受队列事件携带的同名字段。proof 使用 `RELAY_AUTHORIZATION_SIGNING_KEY` 对 base64url JSON payload 做 HMAC-SHA256。启用策略必须配置至少 32 字符密钥，并通过 Secret 注入 Leader、Executor、Reviewer 的环境；不得把值放 prompt、policy、任务正文或日志。为相关 Agent 绑定 `relay-authorization` Skill，运行其校验器，验证签名、eventKey、请求者和委派动作子集。resumeEligible 只是身份资格；只有 Leader 判断当前消息明确恢复同一待人工案件，才形成案件绑定的恢复授权。

发布顺序：保存当前配置快照 → 部署 relay 代码与策略/签名 Secret → 验证生产新建和续接 payload → 绑定核验 Skill 并注入同一 Secret → 更新 Team/Agent prompt 与 CS Skill。切换期间新旧 prompt 可能并存，应检查在途任务，不自动重放已完成消息。历史无签名 payload 不补造授权；若需要恢复，重新以当前入口发送明确请求，取得当前策略签名。回滚必须协调代码、策略和 prompt，不能只回滚一侧。

签名保护上下文来源和完整性，不把模型工具执行变成系统级沙箱，也不提供已发出上下文的实时撤销。实际工具凭据范围、禁部署/禁生产业务操作边界仍适用。不要把本链路声明为不可绕过的写审批。
