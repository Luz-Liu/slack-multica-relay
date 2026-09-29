import { describe, expect, it, vi } from 'vitest';
import { admitDuty, dutyActions } from '../src/duty-http.js';
import type { RelayConfig } from '../src/config.js';
const setup={channelIds:['C1'],qaAccountIds:['qa'],managerSlackIds:['U1'],onCallSlackId:'U1',projectId:'p',agentId:'a',priorityIds:['high','low'],intakeBotIds:['B1']};
const relay={teamId:'T1',botUserIds:new Set(['UBOT']),blockedChannelIds:new Set(),blockedSenderIds:new Set(),kvRestApiUrl:'https://kv.test',kvRestApiToken:'kv',queueUrl:'https://q.test',queueToken:'q',consumerUrl:'https://relay.test/api/queue/consume',multicaWorkspaceId:'w',slackReactionToken:'slack'} as RelayConfig;
function fixture(enabled=true) {
 const fetcher=vi.fn<typeof fetch>(async(input)=>String(input).includes('kv.test')?Response.json({result:JSON.stringify({enabled,endsAt:'2099-01-01',revision:'r'})}):Response.json({messageId:'queued'}));
 return fetcher;
}
describe('duty event intake',()=>{
 it('supports allowlisted report bots without user identity',async()=>{
  const f=fixture();const r=await admitDuty({team_id:'T1',event:{channel:'C1',ts:'1.1',text:'CS-123',bot_id:'B1',subtype:'bot_message'}},relay,{DUTY_SETUP:JSON.stringify(setup)},f);
  expect(await r?.json()).toEqual({action:'duty_accepted'});
  const body=JSON.parse(String(f.mock.calls.at(-1)?.[1]?.body));expect(body.senderUserId).toBe('B1');
 });
 it('rejects other bots and never permits a report bot to change the switch',async()=>{
  for(const event of [{bot_id:'B2',text:'CS-123'},{bot_id:'B1',text:'<@UBOT> 值守 关闭'}]) {
   const f=fixture();expect(await admitDuty({team_id:'T1',event:{channel:'C1',ts:'1.1',...event}},relay,{DUTY_SETUP:JSON.stringify(setup)},f)).toBeUndefined();
   expect(f.mock.calls.some(([u])=>String(u).includes('/publish/'))).toBe(false);
  }
 });
 it('preserves existing unrelated mention and disabled routing',async()=>{
  for(const [text,enabled] of [['<@UBOT> review PR',true],['CS-123',false]] as const) expect(await admitDuty({team_id:'T1',event:{channel:'C1',ts:'1.1',text,user:'U1'}},relay,{DUTY_SETUP:JSON.stringify(setup)},fixture(enabled))).toBeUndefined();
 });
 it('rejects action requests without exact service credentials',async()=>{
  const r=await dutyActions(new Request('https://relay.test/api/duty/actions',{method:'POST',body:'{}'}),{DUTY_AGENT_TOKEN:'x'.repeat(32)});
  expect(r.status).toBe(401);
 });
});
