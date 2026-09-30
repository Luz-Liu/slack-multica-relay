import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DutyService } from '../src/duty-service.js';
import { MemoryThreadStore } from '../src/thread-store.js';
import type { RelayConfig } from '../src/config.js';
import type { DutySetup } from '../src/duty-policy.js';
const setup: DutySetup={channelIds:['C1'],qaAccountIds:['qa'],managerSlackIds:['U1'],onCallSlackId:'U1',projectId:'p',agentId:'a',priorityIds:['high','low']};
const relay={multicaWorkspaceId:'w',blockedChannelIds:new Set(),blockedSenderIds:new Set(),teamId:'T1'} as RelayConfig;
let s: DutyService, proof:string;
beforeEach(async()=>{
 s=new DutyService(setup,relay,new MemoryThreadStore(),{DUTY_SIGNING_KEY:'x'.repeat(32)});
 const state=await s.control('on',new Date(Date.now()+3600000).toISOString());
 proof=s.proof({version:1,source:'cs_duty',ticketId:'1',ticketKey:'CS-1',channelId:'C1',threadTs:'1.1',eventId:'e',revision:state!.revision,expiresAt:state!.endsAt});
});
describe('duty live guard',()=>{
 it('checks admitted context without Jira credentials or network access',async()=>{
  expect(await s.check(proof)).toMatchObject({context:{ticketKey:'CS-1'},admissionBasis:'previously_verified_intake'});
 });
 it('rejects old proofs after off and on',async()=>{
  await s.control('off');await s.control('on',new Date(Date.now()+3600000).toISOString());
  await expect(s.check(proof)).rejects.toThrow('duty_session_changed');
 });
 it('rejects tampered proofs',async()=>{await expect(s.check(proof+'x')).rejects.toThrow('invalid_duty_proof');});
 it('rejects the removed Jira priority write action',async()=>{
  await expect(s.action(proof,'priority-upgrade',{priorityId:'high',reason:'urgent'})).rejects.toThrow('unsupported_duty_action');
 });
 it('retains uncertainty and never retries an ambiguous Slack send',async()=>{
  const slack=vi.spyOn(s,'slack').mockRejectedValue(new Error('timeout'));
  await expect(s.action(proof,'reply',{text:'Conclusion',notify:true})).rejects.toThrow();
  expect(await s.action(proof,'reply',{text:'Conclusion',notify:true})).toEqual({status:'pending'});
  expect(slack).toHaveBeenCalledTimes(1);
 });
 it('binds replies to signed thread and configured human, supports urgent then conclusion',async()=>{
  const slack=vi.spyOn(s,'slack').mockResolvedValue({ts:'2.1'});
  await s.action(proof,'reply',{text:'Urgent',notify:true,phase:'urgent',channel:'C_OTHER'});
  await s.action(proof,'reply',{text:'Conclusion',notify:true});
  expect(slack).toHaveBeenCalledTimes(2);
  expect(slack.mock.calls[0]![1]).toMatchObject({channel:'C1',thread_ts:'1.1',text:'Urgent\n<@U1> 请接手确认。'});
 });
 it('allows a requested follow-up after the automatic conclusion and deduplicates its retries',async()=>{
  const slack=vi.spyOn(s,'slack').mockResolvedValue({ts:'2.1'});
  await s.action(proof,'reply',{text:'Original'});
  const body={text:'Updated conclusion',requestId:'comment-123',notify:true};
  expect(await s.action(proof,'reply',body)).toEqual({status:'sent',ts:'2.1'});
  expect(await s.action(proof,'reply',body)).toEqual({status:'sent',ts:'2.1',replayed:true});
  await expect(s.action(proof,'reply',{...body,text:'Changed'})).rejects.toThrow('reply_request_conflict');
  await expect(s.action(proof,'reply',{...body,phase:'urgent'})).rejects.toThrow('reply_request_conflict');
  expect(slack).toHaveBeenCalledTimes(2);
  await s.action(proof,'reply',{...body,requestId:'comment-456'});
  expect(slack).toHaveBeenCalledTimes(3);
 });
 it('retains uncertain requested sends and rejects changed payloads',async()=>{
  const slack=vi.spyOn(s,'slack').mockRejectedValue(new Error('timeout'));
  const body={text:'Update',requestId:'comment-123'};
  await expect(s.action(proof,'reply',body)).rejects.toThrow('timeout');
  expect(await s.action(proof,'reply',body)).toEqual({status:'pending'});
  await expect(s.action(proof,'reply',{...body,notify:true})).rejects.toThrow('reply_request_conflict');
  expect(slack).toHaveBeenCalledTimes(1);
 });
 it('does not accept a follow-up id as a substitute for active signed authority',async()=>{
  const slack=vi.spyOn(s,'slack');
  await expect(s.action(proof+'x','reply',{text:'Update',requestId:'comment-123'})).rejects.toThrow('invalid_duty_proof');
  await s.control('off');
  await expect(s.action(proof,'reply',{text:'Update',requestId:'comment-123'})).rejects.toThrow();
  expect(slack).not.toHaveBeenCalled();
 });
 it('rejects malformed request ids and keeps missing Slack receipts uncertain',async()=>{
  const slack=vi.spyOn(s,'slack').mockResolvedValue({});
  await expect(s.action(proof,'reply',{text:'Update',requestId:''})).rejects.toThrow('invalid_reply_request_id');
  const body={text:'Update',requestId:'comment-123'};
  await expect(s.action(proof,'reply',body)).rejects.toThrow('invalid_slack_reply_receipt');
  expect(await s.action(proof,'reply',body)).toEqual({status:'pending'});
  expect(slack).toHaveBeenCalledTimes(1);
 });
 it('disabled patrol is silent and makes no Jira requests',async()=>{await s.control('off');expect(await s.patrol()).toEqual({status:'disabled'});});
});
