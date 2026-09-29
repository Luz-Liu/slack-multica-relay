# CS duty guardian

Dedicated project/agent, with no changes to shared reply skills. Absent DUTY_SETUP or absent/expired KV state means duty is off; ordinary mention routing remains available. Setup is deployment configuration; no personal identity belongs in prompts.

Environment: DUTY_SETUP JSON contains channelIds, qaAccountIds, managerSlackIds, onCallSlackId, projectId, agentId, priorityIds (highest urgency first), optional intakeBotIds. DUTY_JIRA_BASE_URL, DUTY_JIRA_EMAIL and DUTY_JIRA_TOKEN support Jira checks; DUTY_SIGNING_KEY signs case envelopes; DUTY_AGENT_TOKEN authenticates the narrow action API. Store secrets as sensitive production variables. The agent only receives DUTY_SERVICE_URL and DUTY_AGENT_TOKEN.

In a configured channel, a manager can address the configured Bot with:

- `@Bot 值守 状态`
- `@Bot 值守 开启 2026-10-08T09:00+08:00` (future explicit deadline, maximum 31 days)
- `@Bot 值守 关闭`

Slack signature verification precedes command interpretation. Command authorization is server-side. Intake integration bots cannot issue control commands. Enabling creates an idempotently named QStash schedule every five minutes; disabling removes it. Expiry fails closed and the next scheduled invocation removes the schedule. Slack continues to deliver subscribed events to the existing relay when duty is off; duty performs no case intake then.

Realtime candidates are exact CS keys in the message or root thread. Only live, unresolved CS tickets currently assigned to the configured QA IDs are dispatched. The service signs the case key, stable Jira ID, bound thread, event, switch revision and expiry. Every analysis/write rechecks live assignment and session. Cases reuse a Multica issue by stable Jira ID, while per-event receipts prevent replay.

Patrol backfills top-level channel messages from 15 minutes before the first run and advances a paginated cursor (20 messages per run). It does not discover old Jira-only reassignments with no new channel activity, or historical thread replies; realtime events cover new replies. Operators should mention the ticket in the channel to resubmit such cases. New Slack message edits are not ingested by the existing relay.

`/api/duty/actions` supports check, priority-upgrade, reply and patrol. Replies use the relay Bot and exact bound thread; the server inserts the configured on-call mention. Urgent alert and final conclusion have separate receipts. Ambiguous sends remain pending rather than risking duplicates. An operator must reconcile pending receipts against Slack. Jira has no atomic compare-and-set across assignee/priority fields: checks narrow but cannot eliminate the external edit race between read and write.

First rollout is off. Unit/integration tests use mocked services; no real CS priority or Slack business-message writes are necessary for deployment verification. Live Slack event subscription, bot channel membership, runtime availability and an authorized end-to-end smoke case must be checked before declaring operational acceptance.
