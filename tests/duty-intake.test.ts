import {afterEach,describe,it,expect,vi} from 'vitest';
import {DutyService, type DutyEvent} from '../src/duty-service.js';
import {intakeAssignee, type DutySetup} from '../src/duty-policy.js';
import {MemoryThreadStore} from '../src/thread-store.js';
import type {RelayConfig} from '../src/config.js';
import * as api from '../src/multica-api.js';
const setup: DutySetup={channelIds:['C1'],intakeBotIds:['B1'],qaAssigneeNames:['QA Example'],qaAccountIds:['qa'],managerSlackIds:['U1'],onCallSlackId:'U1',projectId:'p',agentId:'a',priorityIds:['high','low']};
const relay={multicaWorkspaceId:'w',blockedChannelIds:new Set<string>(),blockedSenderIds:new Set<string>(),teamId:'T1'} as RelayConfig;
const text=':quickly: *CS-123* *Example*\nSee more: <https://example.test/CS-123>\nPriority: P2-High    |    Assignee: QA Example';
const event: DutyEvent={teamId:'T1',channelId:'C1',senderUserId:'B1',messageTs:'1.1',threadTs:'1.1',text};
async function fixture(){
 const store=new MemoryThreadStore(),network=vi.fn<typeof fetch>().mockRejectedValue(new Error('network disabled'));
 const s=new DutyService(setup,relay,store,{DUTY_SIGNING_KEY:'x'.repeat(32)},network);
 await s.control('on',new Date(Date.now()+3600000).toISOString());
 let saved: api.MulticaIssue|undefined;
 vi.spyOn(api,'findIssue').mockImplementation(async()=>saved);
 const create=vi.spyOn(api,'createIssue').mockImplementation(async(_api,title,description)=>saved={id:'i',title,description});
 const comment=vi.spyOn(api,'createComment').mockResolvedValue({id:'c',content:'test'});
 return {s,store,network,create,comment};
}
afterEach(()=>vi.restoreAllMocks());
describe('report-time QA admission',()=>{
 it('extracts the fixed Assignee field rather than a body name',()=>{
  expect(intakeAssignee(text)).toBe('QA Example');
  expect(intakeAssignee('QA Example mentioned this\nAssignee: Other')).toBe('Other');
  expect(intakeAssignee('Description: Assignee: QA Example')).toBeUndefined();
  expect(intakeAssignee('Assignee: QA Example\nAssignee: Other')).toBeUndefined();
 });
 it('admits without any Jira request and binds a reply to the original thread',async()=>{
  const {s,network,create}=await fixture();expect(await s.dispatch(event)).toEqual(['i']);
  const description=create.mock.calls[0]![2];const proof=description.match(/DUTY_PROOF=(\S+)/)![1]!;
  expect(await s.check(proof)).toMatchObject({context:{ticketKey:'CS-123',intakeAssignee:'QA Example'},admissionBasis:'bot_assignee_at_report'});
  expect(network).not.toHaveBeenCalled();
  const slack=vi.spyOn(s,'slack').mockResolvedValue({ts:'2.1'});
  await s.action(proof,'reply',{text:'Summary',notify:true});
  expect(slack).toHaveBeenCalledWith('chat.postMessage',expect.objectContaining({channel:'C1',thread_ts:'1.1'}));
 });
 it('rejects untrusted authors, other channels, replies and partial name matches',async()=>{
  const {s,create}=await fixture();
  for(const e of [{...event,senderUserId:'U1'},{...event,senderUserId:'B2'},{...event,channelId:'C2'},{...event,messageTs:'1.2'},{...event,text:text+' Jr'}]) expect(await s.dispatch(e)).toEqual([]);
  expect(create).not.toHaveBeenCalled();
 });
 it('records malformed intake and lets patrol continue to the next valid report',async()=>{
  const {s,store,create}=await fixture();vi.spyOn(console,'warn').mockImplementation(()=>{});
  vi.spyOn(s,'slack').mockResolvedValue({messages:[{bot_id:'B1',ts:'2.1',text:'CS-999 Assignee unknown'}, {bot_id:'B1',ts:'1.1',text}]});
  await s.patrol();expect(create).toHaveBeenCalledTimes(1);
  expect(JSON.parse((await store.get(s.stateKey+':intake-warning'))!)).toMatchObject({reason:'unrecognized_intake_format'});
  expect(await store.get(s.stateKey+':cursor:C1')).toBeTruthy();
 });
 it('preserves receipt deduplication for tasks admitted by the previous version',async()=>{
  const {s,store,create,comment}=await fixture();
  vi.mocked(api.findIssue).mockResolvedValue({id:'old',title:'[CS Duty] CS-123',description:'<!-- cs-duty:141193 -->\nCS duty case CS-123\n'});
  await store.set(`${s.stateKey}:case:141193:event:C1:1.1`,'old',86400);
  expect(await s.dispatch(event)).toEqual([]);
  expect(create).not.toHaveBeenCalled();expect(comment).not.toHaveBeenCalled();
 });
 it('does not create a duplicate follow-up after a receipt persistence failure',async()=>{
  const {s,store,create,comment}=await fixture();const original=store.set.bind(store);let fail=true;
  vi.spyOn(store,'set').mockImplementation(async(k,v,ttl)=>{if(k.includes(':event:')&&fail){fail=false;throw Error('receipt failed');}return original(k,v,ttl);});
  await expect(s.dispatch(event)).rejects.toThrow('receipt failed');
  expect(await s.dispatch(event)).toEqual(['i']);
  expect(create).toHaveBeenCalledTimes(1);expect(comment).not.toHaveBeenCalled();
 });
});
