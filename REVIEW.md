# Multica 接口契约与验收边界

源码核对：Multica Server v0.4.40；本地 daemon v0.4.36。日期2026-09-05。配置会变化，部署前刷新版本和身份。

## 创建

[CreateIssue](https://github.com/multica-ai/multica/blob/v0.4.40/server/internal/handler/issue.go#L2788) 支持 project/agent 指派。Relay 使用包含thread和配置scope的标题、描述中的来源marker，避开 [Autopilot同标题60秒去重](https://github.com/multica-ai/multica/blob/v0.4.40/server/internal/service/autopilot.go#L675)。

普通API返回active_duplicate_issue/409时，仅在Project、Agent及marker全部匹配后采用已有Issue。其他409不能当成功。

## 恢复

Issue查询扫描专用Project，读取description marker；评论查询按服务端的(time,id)游标翻页。写入前记录intent，响应不明时查回读。无法确认时保留错误进入队列重试/失败保留，不盲目再写。

不保证跨任意故障的exactly-once：Multica评论没有服务端幂等键，租约/网络/人工编辑仍有边界。线程并发由QStash flow control与Redis锁共同约束。来源字段被修改、状态过期或检索超出上限时应人工核对。

## 接收与执行

QStash持久化接收后才能ACK Slack；后台消费失败由队列重试，耗尽可在DLQ检查和重放。QStash、Redis和托管函数是需要分别配置与验收的外部组件。

Relay 的频道和发送者准入同时支持白名单与黑名单。白名单可使用 `all`，黑名单优先；入站和队列消费使用同一套策略。目标用户/User Group 配置仍用于判断是否触发任务。

通过签名和准入校验的 Slack 消息在入队前尽力添加 `SLACK_REACTION_NAME`（默认 `eyes`）。Relay 先在 KV 写入 90 天 attempted 标记，再调用 Slack reactions API；竞争 delivery 在首次 750ms 窗口内等待。reaction 成功、失败或结果不明都不会清除标记，因此重放不会补加迟到 reaction；reaction 失败只降级记录并继续入队。消费函数不再添加 reaction，避免覆盖后续 typing/done 状态。

评论HTTP201表示已保存，可能不触发Agent。Relay返回comment_persisted，不能当作任务执行证明。最终结果以Multica任务和Slack原thread双重回读为准。

## 本地Codex

daemon将Agent instructions写入工作目录AGENTS.md。Skills由本地配置及Workspace指派合入任务环境；不是复制桌面聊天。

[Codex审批处理](https://github.com/multica-ai/multica/blob/v0.4.36/server/pkg/agent/codex.go#L2558)会自动接受命令/文件请求。当前Prompt明确只读默认和逐项授权，但不声称具备强制工具审批。Project不要未经核对就绑定整个个人代码目录为local_directory。

## 本地验证与剩余验收

回归覆盖准入、队列接收失败、两个thread、重复消息、响应丢失、429后消息交错、Agent scope隔离、评论游标。

还需要托管平台真实冷/热延迟、QStash签名/重试/DLQ、Redis网络故障、Mac离线恢复和真实Slack事件订阅验收。未完成这些步骤不能宣布公网接管已可用。

官方平台合同：[Vercel Functions](https://vercel.com/docs/functions)、[EdgeOne Node Functions](https://pages.edgeone.ai/document/node-functions)、[QStash](https://upstash.com/docs/qstash/overall/getstarted)。
