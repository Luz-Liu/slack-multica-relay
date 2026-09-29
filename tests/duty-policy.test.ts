import { describe, expect, it } from 'vitest';
import { dutyActive, dutyCommand, eligibleTicket, isUpgrade, ticketKeys, type DutySetup, type DutyTicket } from '../src/duty-policy.js';
const setup: DutySetup = { channelIds: ['C1'], qaAccountIds: ['qa-a'], managerSlackIds: ['U1'], onCallSlackId: 'U1', projectId: 'p', agentId: 'a', priorityIds: ['high','medium','low'] };
const ticket = (assignee: string | null, key = 'CS-1', category = 'new'): DutyTicket => ({id:'1',key, fields:{assignee: assignee ? {accountId: assignee} : null, status:{statusCategory:{key:category}},priority:{id:'medium'},summary:'test',updated:'now'}});
describe('duty boundary', () => {
 it('admits only current QA assignment on an open CS ticket', () => {
   expect(eligibleTicket(ticket('qa-a'), setup)).toBe(true);
   for (const t of [ticket(null),ticket('qa-b'),ticket('qa-a','TECH-1'),ticket('qa-a','CS-1','done')]) expect(eligibleTicket(t, setup)).toBe(false);
 });
 it('fails closed when disabled, missing, expired or malformed', () => {
   for (const s of [null,{enabled:false,endsAt:'2099-01-01',revision:'1'},{enabled:true,endsAt:'2020-01-01',revision:'1'},{enabled:true,endsAt:'garbage',revision:'1'}]) expect(dutyActive(s)).toBe(false);
 });
 it('requires explicit ordered escalation, rejects downgrade and unknown', () => {
   expect(isUpgrade('medium','high',setup.priorityIds)).toBe(true);
   for (const pair of [['high','low'],['medium','medium'],['unknown','high'],['low','unknown']]) expect(isUpgrade(pair[0]!,pair[1]!,setup.priorityIds)).toBe(false);
 });
 it('only accepts exact addressed commands and timezone-qualified deadlines', () => {
   const bots = new Set(['U9']);
   expect(dutyCommand('<@U9> 值守 开启 2026-10-08T09:00+08:00',bots)?.action).toBe('on');
   expect(dutyCommand('<@U9> 值守 关闭',bots)?.action).toBe('off');
   for (const text of ['值守 关闭','<@U8> 值守 关闭','<@U9> 请引用“值守 关闭”','<@U9> 值守 开启 2026-10-08']) expect(dutyCommand(text,bots)).toBeUndefined();
 });
 it('deduplicates ticket references', () => expect(ticketKeys('CS-123 cs-123 https://x/CS-456')).toEqual(['CS-123','CS-456']));
});
