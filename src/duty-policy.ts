/** Deterministic admission; identities belong in deployment configuration, never prompts. */
export interface DutySetup {
  channelIds: string[];
  intakeBotIds?: string[];
  /** Exact display names from trusted Bug Report Bot Assignee fields. */
  qaAssigneeNames?: string[];
  /** Legacy configuration, unused by report-time admission. */
  qaAccountIds?: string[];
  managerSlackIds: string[];
  onCallSlackId: string;
  projectId: string;
  agentId: string;
  /** Legacy configuration; the relay no longer writes Jira priorities. */
  priorityIds?: string[];
}
export interface DutyState { enabled: boolean; endsAt: string; revision: string }
export function dutySetup(raw: string | undefined): DutySetup | undefined {
  if (!raw) return;
  const v = JSON.parse(raw) as DutySetup;
  for (const key of ['channelIds', 'managerSlackIds'] as const) {
    if (!Array.isArray(v[key]) || !v[key].length || v[key].some(x => typeof x !== 'string' || !x.trim()) || new Set(v[key]).size !== v[key].length) throw new Error('invalid_duty_setup');
  }
  if (v.intakeBotIds && (!Array.isArray(v.intakeBotIds) || v.intakeBotIds.some(x=>!/^B[A-Z0-9]+$/.test(x)))) throw new Error('invalid_duty_setup');
  if (!/^U[A-Z0-9]+$/.test(v.onCallSlackId) || !v.projectId || !v.agentId) throw new Error('invalid_duty_setup');
  if (v.qaAssigneeNames && (!v.qaAssigneeNames.length || v.qaAssigneeNames.some(x => typeof x !== 'string' || !x.trim()) || new Set(v.qaAssigneeNames).size !== v.qaAssigneeNames.length)) throw new Error('invalid_duty_setup');
  return v;
}
export function dutyActive(state: DutyState | null, now = Date.now()): boolean {
  return state?.enabled === true && Number.isFinite(Date.parse(state.endsAt)) && Date.parse(state.endsAt) > now;
}
export function ticketKeys(text: string): string[] {
  return [...new Set(text.match(/\bCS-\d+\b/gi)?.map(k => k.toUpperCase()) ?? [])].slice(0, 10);
}
export type DutyCommand = { action: 'status' | 'off' } | { action: 'on'; endsAt: string };
export function dutyCommand(text: string, botIds: Set<string>): DutyCommand | undefined {
  if (![...botIds].some(id => text.includes(`<@${id}>`))) return;
  const command = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (/^值守\s*(状态|status)$/i.test(command)) return { action: 'status' };
  if (/^值守\s*(关闭|off)$/i.test(command)) return { action: 'off' };
  const match = command.match(/^值守\s*(?:开启|on)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))$/i);
  if (match) return { action: 'on', endsAt: match[1]! };
}

/** Parse a field, never search the body for a QA name. */
export function intakeAssignee(text: string): string | undefined {
  const matches = [...text.matchAll(/^(?:Priority:[^|\r\n]+\|[ \t]*)?Assignee:[ \t]*([^|\r\n]+)[ \t]*$/gm)];
  if (matches.length !== 1) return;
  return matches[0]![1]!.trim();
}
