import { timingSafeEqual } from 'node:crypto';
import { Receiver } from '@upstash/qstash';
import { loadRelayConfig, type RelayConfig } from './config.js';
import { UpstashThreadStore } from './thread-store.js';
import { dutySetup, dutyCommand, dutyActive, ticketKeys } from './duty-policy.js';
import { DutyService, type DutyEvent } from './duty-service.js';
import { lookupSlackAuthor } from './slack-author.js';
import { digest } from './thread-router.js';
const reply = (value: unknown,status=200) => Response.json(value,{status});
function service(env: NodeJS.ProcessEnv, relay: RelayConfig, fetchImpl: typeof fetch): DutyService | undefined {
 const setup=dutySetup(env.DUTY_SETUP); if(!setup) return;
 return new DutyService(setup,relay,new UpstashThreadStore(relay.kvRestApiUrl,relay.kvRestApiToken,fetchImpl),env,fetchImpl);
}
/** Called only after the original Slack signature and event envelope checks. */
export async function admitDuty(body: Record<string,unknown>, relay: RelayConfig, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<Response | undefined> {
 const s=service(env,relay,fetchImpl); if(!s) return;
 const e=body.event as Record<string,unknown>;
 if(body.team_id!==relay.teamId || typeof e.channel!=='string' || !s.setup.channelIds.includes(e.channel) || relay.blockedChannelIds.has(e.channel)) return;
 const command=dutyCommand(String(e.text??''),relay.botUserIds);
 if(!command && !dutyActive(await s.state())) return;
 // Explicit unrelated mentions keep their existing routing behavior.
 if(!command && /<[@!]/.test(String(e.text??'')) && !ticketKeys(String(e.text??'')).length) return;
 const intakeBot=typeof e.bot_id==='string' && s.setup.intakeBotIds?.includes(e.bot_id);
 const sender=intakeBot?String(e.bot_id):e.user;
 if(typeof sender!=='string' || relay.blockedSenderIds.has(sender) || (command && intakeBot)) return;
 if(!intakeBot) {
   if(e.bot_id || e.subtype==='bot_message') return;
   if((await lookupSlackAuthor(sender,relay.slackReactionToken,fetchImpl)).isBot) return;
 }
 const event: DutyEvent={teamId:relay.teamId,channelId:e.channel,senderUserId:sender,messageTs:String(e.ts),threadTs:String(e.thread_ts??e.ts),text:String(e.text??'')};
 // All network work goes to the durable queue, including switch replies.
 const consumer=new URL('/api/duty/consume',relay.consumerUrl).href;
 const r=await fetchImpl(relay.queueUrl+'/v2/publish/'+consumer,{method:'POST',headers:{authorization:`Bearer ${relay.queueToken}`,'content-type':'application/json','Upstash-Deduplication-Id':digest('duty:'+event.channelId+':'+event.messageTs),'Upstash-Retries':'3','Upstash-Timeout':'50s','Upstash-Flow-Control-Key':digest('duty:'+s.setup.projectId),'Upstash-Flow-Control-Value':'parallelism=1'},body:JSON.stringify(event),signal:AbortSignal.timeout(1800)});
 if(!r.ok) return reply({error:'duty_queue_unavailable'},503);
 return reply({action:'duty_accepted'});
}
export async function consumeDuty(request: Request,env: NodeJS.ProcessEnv=process.env,fetchImpl: typeof fetch=fetch): Promise<Response> {
 if(request.method!=='POST') return reply({error:'method_not_allowed'},405);
 try {
  const relay=loadRelayConfig(env),s=service(env,relay,fetchImpl); if(!s) return reply({action:'disabled'});
  const raw=await request.text(); if(raw.length>256*1024) return reply({error:'too_large'},413);
  const receiver=new Receiver({currentSigningKey:relay.queueCurrentSigningKey,nextSigningKey:relay.queueNextSigningKey});
  try {if(!await receiver.verify({body:raw,signature:request.headers.get('upstash-signature')??'',url:new URL('/api/duty/consume',relay.consumerUrl).href})) return reply({error:'invalid_signature'},401);} catch {return reply({error:'invalid_signature'},401);}
  const e=JSON.parse(raw) as DutyEvent;
  if(e.teamId!==relay.teamId || !s.setup.channelIds.includes(e.channelId) || relay.blockedChannelIds.has(e.channelId) || relay.blockedSenderIds.has(e.senderUserId) || !/^[UB][A-Z0-9]+$/.test(e.senderUserId) || !/^\d+\.\d+$/.test(e.messageTs) || !/^\d+\.\d+$/.test(e.threadTs) || typeof e.text!=='string') return reply({action:'ignored'});
  const intakeBot=s.setup.intakeBotIds?.includes(e.senderUserId);
  if(!intakeBot && (e.senderUserId.startsWith('B') || (await lookupSlackAuthor(e.senderUserId,relay.slackReactionToken,fetchImpl)).isBot)) return reply({action:'ignored'});
  const command=dutyCommand(e.text,relay.botUserIds);
  if(command) {
   if(intakeBot || !s.setup.managerSlackIds.includes(e.senderUserId)) return reply({action:'unauthorized_control'});
   const key=s.stateKey+':command:'+e.messageTs;
   // Prevent Slack/QStash replay from re-enabling a previously disabled session.
   if(await s.store.get(key)) return reply({action:'duplicate'});
   const state=command.action==='status'?await s.state():await s.manage(command.action,command.action==='on'?command.endsAt:undefined,'slack:'+e.channelId+':'+e.messageTs);
   await s.store.set(key,'applied',32*86400);
   await s.slack('chat.postMessage',{channel:e.channelId,thread_ts:e.threadTs,text:`CS 值守：${dutyActive(state)?'开启':'关闭'}${state?.enabled?`；截止 ${state.endsAt}`:''}。仅处理当前分配给配置 QA 名单的未结束 CS 单。`});
   return reply({action:'controlled'});
  }
  if(!dutyActive(await s.state())) return reply({action:'disabled'});
  return reply({issues:await s.dispatch(e)});
 } catch(e) { return reply({error:safeError(e)},503); }
}
function safeError(e: unknown): string {
 const allowed=['duty_off','duty_session_changed','qa_scope_changed','invalid_duty_proof','invalid_deadline','priority_upgrade_only','invalid_reply','reply_busy','duty_case_busy','duty_jira_not_configured'];
 return e instanceof Error && allowed.includes(e.message)?e.message:'duty_operation_failed';
}
export async function dutyActions(request: Request,env: NodeJS.ProcessEnv=process.env,fetchImpl: typeof fetch=fetch): Promise<Response> {
 if(request.method!=='POST') return reply({error:'method_not_allowed'},405);
 const token=env.DUTY_AGENT_TOKEN, provided=request.headers.get('authorization')??'';
 if(!token || token.length<32 || provided.length!==token.length+7 || !timingSafeEqual(Buffer.from(provided),Buffer.from('Bearer '+token))) return reply({error:'unauthorized'},401);
 try {
  const s=service(env,loadRelayConfig(env),fetchImpl); if(!s) return reply({error:'duty_off'},409);
  const raw=await request.text(); if(raw.length>24000) return reply({error:'too_large'},413);
  const body=JSON.parse(raw); if(body.action==='readiness') return reply(await s.readiness());
  if(body.action==='patrol') return reply(await s.patrol());
  if(typeof body.proof!=='string' || typeof body.action!=='string') return reply({error:'invalid_body'},400);
  return reply(await s.action(body.proof,body.action,body));
 } catch(e) {return reply({error:safeError(e)},409);}
}

export async function patrolDuty(request: Request,env: NodeJS.ProcessEnv=process.env,fetchImpl: typeof fetch=fetch): Promise<Response> {
 if(request.method!=='POST') return reply({error:'method_not_allowed'},405);
 try {
  const relay=loadRelayConfig(env),s=service(env,relay,fetchImpl); if(!s) return reply({action:'disabled'});
  const raw=await request.text();
  try {if(!await new Receiver({currentSigningKey:relay.queueCurrentSigningKey,nextSigningKey:relay.queueNextSigningKey}).verify({body:raw,signature:request.headers.get('upstash-signature')??'',url:new URL('/api/duty/patrol',relay.consumerUrl).href})) return reply({error:'invalid_signature'},401);} catch {return reply({error:'invalid_signature'},401);}
  if(!dutyActive(await s.state())) {await s.schedule(false);return reply({action:'disabled'});}
  return reply(await s.patrol());
 } catch(e) {return reply({error:safeError(e)},503);}
}

/** Operator-only control plane. Its credential is never supplied to the duty agent. */
export async function dutyAdmin(request: Request,env: NodeJS.ProcessEnv=process.env,fetchImpl: typeof fetch=fetch): Promise<Response> {
 const respond=(value:unknown,status=200)=>{const r=reply(value,status);r.headers.set('cache-control','no-store');return r;};
 if(request.method!=='POST') return respond({error:'method_not_allowed'},405);
 const token=env.DUTY_ADMIN_TOKEN,provided=request.headers.get('authorization')??'';
 if(!token || token.length<32 || provided.length!==token.length+7 || !timingSafeEqual(Buffer.from(provided),Buffer.from('Bearer '+token))) return respond({error:'unauthorized'},401);
 let body: any;
 try {const raw=await request.text();if(raw.length>2048)return respond({error:'too_large'},413);body=JSON.parse(raw);} catch {return respond({error:'invalid_body'},400);}
 if(!body || !['on','off','status'].includes(body.action)) return respond({error:'invalid_action'},400);
 if(body.action!=='status' && (typeof body.requestId!=='string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId))) return respond({error:'request_id_required'},400);
 if(body.action==='on' && (typeof body.endsAt!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.endsAt))) return respond({error:'invalid_deadline'},400);
 try {
  const s=service(env,loadRelayConfig(env),fetchImpl);if(!s) return respond({error:'duty_not_configured'},409);
  if(body.action!=='status') await s.manage(body.action,body.action==='on'?body.endsAt:undefined,body.requestId);
  return respond({ok:true,...await s.managementStatus() as object});
 } catch(e) {
  const reason=e instanceof Error?e.message:'';
  if(['invalid_deadline','request_id_conflict','duty_control_busy'].includes(reason)) return respond({error:reason},409);
  return respond({error:'control_or_status_failed',hint:'Query status before retrying; reuse the same requestId for a retry.'},503);
 }
}
