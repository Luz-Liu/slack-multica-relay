import { describe, expect, it } from 'vitest';
import { dutyActive, dutyCommand, ticketKeys, type DutySetup } from '../src/duty-policy.js';
const setup: DutySetup = { channelIds: ['C1'], qaAccountIds: ['qa-a'], managerSlackIds: ['U1'], onCallSlackId: 'U1', projectId: 'p', agentId: 'a', priorityIds: ['high','medium','low'] };
describe('duty boundary', () => {
 it('fails closed when disabled, missing, expired or malformed', () => {
   for (const s of [null,{enabled:false,endsAt:'2099-01-01',revision:'1'},{enabled:true,endsAt:'2020-01-01',revision:'1'},{enabled:true,endsAt:'garbage',revision:'1'}]) expect(dutyActive(s)).toBe(false);
 });
 it('only accepts exact addressed commands and timezone-qualified deadlines', () => {
   const bots = new Set(['U9']);
   expect(dutyCommand('<@U9> 值守 开启 2026-10-08T09:00+08:00',bots)?.action).toBe('on');
   expect(dutyCommand('<@U9> 值守 关闭',bots)?.action).toBe('off');
   for (const text of ['值守 关闭','<@U8> 值守 关闭','<@U9> 请引用“值守 关闭”','<@U9> 值守 开启 2026-10-08']) expect(dutyCommand(text,bots)).toBeUndefined();
 });
 it('deduplicates ticket references', () => expect(ticketKeys('CS-123 cs-123 https://x/CS-456')).toEqual(['CS-123','CS-456']));
});
