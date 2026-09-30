import { afterEach, describe, expect, it, vi } from 'vitest';
import { dutyAdmin } from '../src/duty-http.js';
import { DutyService } from '../src/duty-service.js';
import { MemoryThreadStore } from '../src/thread-store.js';
import type { RelayConfig } from '../src/config.js';
const token='admin-'.repeat(8);
const setup={channelIds:['C1'],qaAccountIds:['qa'],managerSlackIds:['U1'],onCallSlackId:'U1',projectId:'p',agentId:'a',priorityIds:['high','low']};
const env={DUTY_ADMIN_TOKEN:token,DUTY_AGENT_TOKEN:'agent-'.repeat(8),DUTY_SETUP:JSON.stringify(setup),SLACK_SIGNING_SECRET:'s',SLACK_TEAM_ID:'T1',SLACK_TARGET_USER_IDS:'U1',MULTICA_API_BASE_URL:'https://m.test',MULTICA_API_TOKEN:'t',MULTICA_WORKSPACE_ID:'w',MULTICA_PROJECT_ID:'p',MULTICA_AGENT_ID:'a',SLACK_REACTION_TOKEN:'t',KV_REST_API_URL:'https://kv.test',KV_REST_API_TOKEN:'t',QSTASH_TOKEN:'t',QSTASH_CURRENT_SIGNING_KEY:'t',QSTASH_NEXT_SIGNING_KEY:'t',RELAY_CONSUMER_URL:'https://r.test/api/queue/consume'};
const request=(body:unknown,credential=token)=>new Request('https://r.test/api/duty/admin',{method:'POST',headers:{authorization:'Bearer '+credential},body:JSON.stringify(body)});
afterEach(()=>vi.restoreAllMocks());
describe('operator control',()=>{
 it('rejects missing, incorrect and agent credentials',async()=>{
  for(const t of ['', 'wrong',env.DUTY_AGENT_TOKEN]) expect((await dutyAdmin(request({action:'status'},t),env)).status).toBe(401);
 });
 it('validates mutations before accessing dependencies',async()=>{
  expect((await dutyAdmin(request({action:'on'}),env)).status).toBe(400);
  expect((await dutyAdmin(request({action:'on',requestId:'a'.repeat(16),endsAt:'tomorrow'}),env)).status).toBe(400);
 });
 it('status has no control side effects and cannot be cached',async()=>{
  const manage=vi.spyOn(DutyService.prototype,'manage');vi.spyOn(DutyService.prototype,'managementStatus').mockResolvedValue({enabled:false,schedule:{exists:false}});
  const r=await dutyAdmin(request({action:'status'}),env);expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');expect(manage).not.toHaveBeenCalled();
 });
 it('uses the shared control path and returns live state',async()=>{
  const manage=vi.spyOn(DutyService.prototype,'manage').mockResolvedValue(null);vi.spyOn(DutyService.prototype,'managementStatus').mockResolvedValue({enabled:false});
  expect((await dutyAdmin(request({action:'off',requestId:'a'.repeat(16)}),env)).status).toBe(200);
  expect(manage).toHaveBeenCalledWith('off',undefined,'a'.repeat(16));
 });
 it('never reports success when scheduling fails',async()=>{
  vi.spyOn(DutyService.prototype,'manage').mockRejectedValue(new Error('schedule failed'));
  expect((await dutyAdmin(request({action:'off',requestId:'a'.repeat(16)}),env)).status).toBe(503);
 });
 it('rolls back failed enable and prevents replay from re-enabling after off',async()=>{
  const s=new DutyService(setup,{multicaWorkspaceId:'w'} as RelayConfig,new MemoryThreadStore(),{});
  const schedule=vi.spyOn(s,'schedule').mockRejectedValueOnce(new Error('failed')).mockResolvedValue();
  const end=new Date(Date.now()+3600000).toISOString();
  await expect(s.manage('on',end,'first')).rejects.toThrow('failed');expect((await s.state())?.enabled).toBe(false);
  await s.manage('on',end,'second');await s.manage('off',undefined,'third');await s.manage('on',end,'second');
  expect((await s.state())?.enabled).toBe(false);expect(schedule).toHaveBeenCalledTimes(3);
  await expect(s.manage('off',undefined,'second')).rejects.toThrow('request_id_conflict');
 });
});
