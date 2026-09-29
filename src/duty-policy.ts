/** Deterministic admission; identities belong in deployment configuration, never prompts. */
export interface DutySetup {
  channelIds: string[];
  intakeBotIds?: string[];
  qaAccountIds: string[];
  managerSlackIds: string[];
  onCallSlackId: string;
  projectId: string;
  agentId: string;
  /** Explicit business order, highest urgency first. Never sort Jira IDs. */
  priorityIds: string[];
}
export interface DutyState { enabled: boolean; endsAt: string; revision: string }
export interface DutyTicket {
  id: string; key: string;
  fields: { assignee: { accountId: string } | null; status: { statusCategory: { key: string } }; priority: { id: string }; updated: string; summary: string };
}
export function dutySetup(raw: string | undefined): DutySetup | undefined {
  if (!raw) return;
  const v = JSON.parse(raw) as DutySetup;
  for (const key of ['channelIds', 'qaAccountIds', 'managerSlackIds', 'priorityIds'] as const) {
    if (!Array.isArray(v[key]) || !v[key].length || v[key].some(x => typeof x !== 'string' || !x.trim()) || new Set(v[key]).size !== v[key].length) throw new Error('invalid_duty_setup');
  }
  if (v.intakeBotIds && (!Array.isArray(v.intakeBotIds) || v.intakeBotIds.some(x=>!/^B[A-Z0-9]+$/.test(x)))) throw new Error('invalid_duty_setup');
  if (!/^U[A-Z0-9]+$/.test(v.onCallSlackId) || !v.projectId || !v.agentId) throw new Error('invalid_duty_setup');
  return v;
}
export function dutyActive(state: DutyState | null, now = Date.now()): boolean {
  return state?.enabled === true && Number.isFinite(Date.parse(state.endsAt)) && Date.parse(state.endsAt) > now;
}
export function eligibleTicket(ticket: DutyTicket, setup: DutySetup): boolean {
  return /^CS-\d+$/.test(ticket.key) && !!ticket.fields.assignee && setup.qaAccountIds.includes(ticket.fields.assignee.accountId) && ticket.fields.status.statusCategory.key !== 'done';
}
export function isUpgrade(current: string, proposed: string, order: string[]): boolean {
  const from = order.indexOf(current), to = order.indexOf(proposed);
  return from >= 0 && to >= 0 && to < from;
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
