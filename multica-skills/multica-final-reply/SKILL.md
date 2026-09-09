---
name: multica-final-reply
description: 在 Multica 的 Slack Task Router 需要向原线程发送已获授权的最终答复时使用，涵盖成功、失败、阻塞和部分完成；整理当前运行的统计与成果证据，组织正文和 Footer，并通过现有 Slack Skill 发送。
---

# Multica 最终回复

仅供 Multica 的 Slack Task Router 使用。本轮需要向原线程发送已获授权的最终答复时调用，包括成功、失败、阻塞和部分完成。是否需要回复遵循 Agent Prompt 的判断与静默条件。此 Skill 指导回复内容，`scripts/run_context.py` 只读整理资料；最终发送统一使用现有 slack Skill。

## 回复流程

1. 读取目标环境的 slack Skill，以及 [个人回复风格](references/reply-style.md) 和 [Emoji 使用指南](references/emoji-guide.md)。按个人风格组织结论、实际完成的动作、必要证据和未完成事项；需要更多自定义表情时才检索本地完整目录，不逐次联网拉取。PR Review 任务另读 [PR Review 回执](references/pr-review-receipt.md)。
2. 执行 `rtk proxy python3 <本 Skill 路径>/scripts/run_context.py --issue <当前 Issue UUID> --issue-identifier <当前任务编号> --workspace-slug <当前工作区 slug> --app-url <Multica 网页根地址> --output <任务私有目录/context.json>`。任务编号、工作区 slug 和网页根地址按传入参数生成链接；编号复用本轮已有任务详情的 `identifier`。这三个参数可选，缺失时省略链接，不为 Footer 额外查询。脚本使用真实 `MULTICA_TASK_ID`，校验当前 run 的任务归属，查询所属 Agent 配置和 run-messages，输出 `statistics`、带日志序号的 `code_evidence`，以及信息完整时的 `issue_identifier`、`issue_url`。链接使用已校验的 issue UUID；脚本不读取对话上下文，不用 run ID 拼链接，不选择最近一次 run，不轮询等日志补齐。
3. 采集成功时读取输出，根据业务任务从 `code_evidence` 的调用与结果中提取实际处理的 PR、仓库和分支。证据是候选，不等于已完成的成果；排除仅讨论、示例及失败操作。缺失或截断的输出不能当完整证据，必要时按 github-workflow 只读补查。没有 PR 的分支也可展示，但必须有明确的仓库归属和实际分支证据。采集失败或输出不可用时，跳过该输出，依据本轮已有业务证据继续后续组装与发送；省略无法核验的统计和成果字段，不伪造数据、不读取其他 run 或遗留输出补值，不为补齐 Footer 反复重试。辅助采集失败不阻断已获授权的最终答复；原线程、User 身份和发送预检仍须满足下述要求。
4. 读取 [Footer 展示](references/footer-display.md)，按其规则组装最终正文、Footer context blocks 和包含同样信息的 fallback。
5. 按 slack Skill 的发送流程，以 User actor 向原 `channelId` 和根 `threadTs` 一次发送完整消息。直接使用它的 `send --as user --channel ... --thread-ts ... --text-file ... --blocks-file ...`，预检与确认参数以该 Skill 当前版本为准。发送成功后结束，不再追加或更新 Footer。结果不明时先回读原线程，遵守 Slack Skill 的失败处理规则，不自动重发。

发送身份固定为 User，不因 Bot 未安装或发送失败改用 Bot。当前任务已获授权的普通最终答复无需再次确认发送；本 Skill 不决定是否介入、不扩大业务操作权限，静默条件及外部写入授权遵循 Agent Prompt。

资料脚本依赖已认证的 Multica CLI，以及 `MULTICA_SERVER_URL`、`MULTICA_WORKSPACE_ID`、`MULTICA_TASK_ID`。发送凭据、身份预检、消息格式和错误处理全部遵循现有 slack Skill；本 Skill 不提供发送脚本、回执存储或消息更新服务。

## References

以下路径相对于本 SKILL.md。按读取时机加载对应文件，再执行其规则；不把整份 references 目录一次性读入上下文。

| 文件 | 内容 | 读取时机 |
| --- | --- | --- |
| [个人回复风格](references/reply-style.md) | 语气、篇幅、标点和结论表达 | 每次撰写最终正文前必读 |
| [Emoji 使用指南](references/emoji-guide.md) | 本人上传的常用表情、适用语境和选择方式 | 每次撰写最终正文前必读 |
| [PR Review 回执](references/pr-review-receipt.md) | 审查结论、问题数量、review 链接及未完成状态的回执规则 | 当前任务涉及 PR Review 或复审时必读，包括审查未完成或写回失败的情况 |
| [Footer 展示](references/footer-display.md) | 统计口径、模型来源、PR/分支布局和缺失字段处理 | 每次组装 Footer 与 fallback 前必读 |
| [完整 Emoji 目录](references/emoji-catalog.json) | 工作区表情名称、图片地址、别名状态和停用项 | 常用指南不足以选出合适表情时，按名称检索少量条目；不整份加载，不逐次联网刷新 |
