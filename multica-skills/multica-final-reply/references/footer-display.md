# Footer 展示

组装完整正文、Footer context blocks 和包含同样信息的 fallback。每个 PR 单独一行，PR 去重；仓库只显示 repo，查询、去重和链接使用完整 owner/repo。保留每个 PR 对应的分支，无成果时省略对应行。

- 统计行：`:agent_time: 耗时 · :agent_mdi_robot_outline_muted: 模型 · :agent_tool: N tools · :agent_skill: N skills`。按实际有效字段拼接，缺失及零次 tools/skills 隐藏，不展示 token 和缓存率。
- Multica 入口：当 `issue_identifier`、`issue_url` 同时存在时，在统计行末尾追加 ` · :agent_multica: <issue_url|#issue_identifier>`，例如 ` · :agent_multica: <https://multica.example/grm/issues/00000000-0000-4000-8000-000000000001|#GRM-87>`。它属于同一个 context block 的同一段 mrkdwn，不新增独立一行，也不放到 PR 行末尾；手机宽度不足时允许自然换行。统计字段全缺失时只展示入口，不加前导分隔符。入口只出现一次，PR 行继续放在下方；fallback 同样保留编号与实际 URL。缺少链接字段时省略入口，不自行补查或拼接猜测值。
- PR 行：`:agent_mdi_github: repo · 分支 · <完整 PR URL|PR #编号>`。分支放行内代码；普通文本按 Slack mrkdwn 转义，不改变真实链接。
- `duration_seconds` 截至采集时刻；tools 是已返回日志中的 tool_use 数量；skills 是从读取命令和返回 frontmatter 确认的 Skill 名称数，按名称去重；并行返回按名称与路径关联，无法确认的读取省略。统计不包含采集后的分析与发送，也不代表运行结束后的完整总量。
- 模型来自当前 run 所属 Agent 的 `model` 配置，`model_source=agent_config`；展示的是配置模型。不能使用模型自我介绍、历史快照或示例补值。
- 运行记录只供组织回复，不将原始日志、凭据或私有路径发到 Slack。脚本返回的缺失字段不需要在面向用户的 Footer 中解释或占位。
