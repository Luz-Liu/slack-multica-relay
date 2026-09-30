import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RelayConfig } from './config.js';
import type { ThreadStore } from './thread-store.js';
import { createIssue, createComment, findIssue, findComment, type ApiConfig } from './multica-api.js';
import { dutyActive, intakeAssignee, ticketKeys, type DutySetup, type DutyState } from './duty-policy.js';
export interface DutyEvent { teamId: string; channelId: string; threadTs: string; messageTs: string; text: string; senderUserId: string }
interface Context { version: 1; source: 'cs_duty'; ticketKey: string; ticketId: string; channelId: string; threadTs: string; revision: string; expiresAt: string; eventId: string; intakeAssignee?: string }
export class DutyService {
  readonly stateKey: string;
  readonly api: ApiConfig;
  constructor(readonly setup: DutySetup, readonly relay: RelayConfig, readonly store: ThreadStore, readonly env: NodeJS.ProcessEnv, readonly fetchImpl: typeof fetch = fetch) {
    this.stateKey = `duty:${relay.multicaWorkspaceId}:${setup.projectId}:state`;
    this.api = {...relay,multicaProjectId:setup.projectId,multicaAssigneeType:'agent',multicaAssigneeId:setup.agentId,multicaLegacyAgentId:undefined};
  }
  async state(): Promise<DutyState | null> { const raw = await this.store.get(this.stateKey); return raw ? JSON.parse(raw) as DutyState : null; }
  async active(): Promise<DutyState> { const s = await this.state(); if (!dutyActive(s)) throw new Error('duty_off'); return s!; }
  async control(action: 'on' | 'off' | 'status', endsAt?: string): Promise<DutyState | null> {
    if (action === 'status') return this.state();
    if (action === 'on' && (!endsAt || !Number.isFinite(Date.parse(endsAt)) || Date.parse(endsAt) <= Date.now() || Date.parse(endsAt) > Date.now()+31*86400000)) throw new Error('invalid_deadline');
    const s: DutyState = {enabled:action === 'on', endsAt: endsAt ?? new Date().toISOString(), revision:randomUUID()};
    await this.store.set(this.stateKey,JSON.stringify(s),32*86400); return s;
  }
  /** Shared by Slack and the admin API; receipts make retries safe across sessions. */
  async manage(action: 'on' | 'off', endsAt: string | undefined, requestId: string): Promise<DutyState | null> {
    const lock=this.stateKey+':control-lock', owner=randomUUID();
    if(!await this.store.setIfAbsent(lock,owner,60)) throw new Error('duty_control_busy');
    try {
      const key=this.stateKey+':control:'+requestId;
      const fingerprint=JSON.stringify({action,endsAt:endsAt??null});
      const receipt=await this.store.get(key);
      if(receipt) {
        if(JSON.parse(receipt).fingerprint!==fingerprint) throw new Error('request_id_conflict');
        return this.state();
      }
      const state=await this.control(action,endsAt);
      try {await this.schedule(action==='on');}
      catch(error) {if(action==='on') await this.control('off');throw error;}
      await this.store.set(key,JSON.stringify({fingerprint}),32*86400);
      return state;
    } finally {await this.store.releaseIfOwner(lock,owner);}
  }
  async managementStatus(): Promise<unknown> {
    const state=await this.state();
    const r=await this.fetchImpl(this.relay.queueUrl+'/v2/schedules/cs-duty-'+this.setup.projectId,{
      headers:{authorization:`Bearer ${this.relay.queueToken}`},signal:AbortSignal.timeout(8000)});
    if(!r.ok && r.status!==404) throw new Error('duty_schedule_unavailable');
    const schedule=r.ok?await r.json():null;
    return {enabled:dutyActive(state),endsAt:state?.endsAt??null,revision:state?.revision??null,
      schedule:{exists:!!schedule,paused:schedule?.isPaused??false},
      intakeWarning:JSON.parse(await this.store.get(this.stateKey+':intake-warning') ?? 'null')};
  }
  async schedule(enabled: boolean): Promise<void> {
    const id='cs-duty-'+this.setup.projectId;
    const destination=new URL('/api/duty/patrol',this.relay.consumerUrl).href;
    const r=await this.fetchImpl(this.relay.queueUrl+'/v2/schedules/'+(enabled?destination:id),{
      method:enabled?'POST':'DELETE',headers:{authorization:`Bearer ${this.relay.queueToken}`,
      ...(enabled?{'Upstash-Cron':'*/5 * * * *','Upstash-Schedule-Id':id,'Upstash-Retries':'2','Upstash-Timeout':'50s','content-type':'application/json'}:{})},
      ...(enabled?{body:'{}'}:{}),signal:AbortSignal.timeout(8000)});
    if(!r.ok && !(r.status===404 && !enabled)) throw new Error('duty_schedule_failed');
  }
  async slack(method: string, body: object): Promise<any> {
    const read=method.startsWith('conversations.') || method==='auth.test';
    const query=new URLSearchParams(Object.entries(body).map(([k,v])=>[k,String(v)]));
    const r = await this.fetchImpl('https://slack.com/api/'+method+(read?'?'+query:''),{method:read?'GET':'POST',headers:{authorization:`Bearer ${this.relay.slackReactionToken}`,'content-type':'application/json'},...(!read?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});
    const v = await r.json(); if (!r.ok || !v.ok) throw new Error('duty_slack_failed'); return v;
  }
  proof(context: Context): string {
    const key = this.env.DUTY_SIGNING_KEY; if (!key || key.length<32) throw new Error('duty_key_missing');
    const body = Buffer.from(JSON.stringify(context)).toString('base64url'); return body+'.'+createHmac('sha256',key).update(body).digest('hex');
  }
  verify(proof: string): Context {
    const key = this.env.DUTY_SIGNING_KEY; if (!key || key.length<32) throw new Error('duty_key_missing');
    const [body,sig,...extra] = proof.split('.');
    const expected = createHmac('sha256',key).update(body??'').digest('hex');
    if (extra.length || !sig || sig.length!==expected.length || !timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) throw new Error('invalid_duty_proof');
    const c = JSON.parse(Buffer.from(body!,'base64url').toString()) as Context;
    if (c.version!==1 || c.source!=='cs_duty' || !/^CS-\d+$/.test(c.ticketKey) || typeof c.ticketId!=='string' || !c.ticketId || typeof c.eventId!=='string' || !c.eventId || !this.setup.channelIds.includes(c.channelId) || this.relay.blockedChannelIds.has(c.channelId) || !/^\d+\.\d+$/.test(c.threadTs) || !(Date.parse(c.expiresAt)>Date.now())) throw new Error('invalid_duty_proof');
    return c;
  }
  async check(proof: string): Promise<{context: Context; onCallSlackId: string; admissionBasis: string}> {
    const c = this.verify(proof), state = await this.active();
    if (c.revision!==state.revision) throw new Error('duty_session_changed');
    return {context:c,onCallSlackId:this.setup.onCallSlackId,admissionBasis:c.intakeAssignee?'bot_assignee_at_report':'previously_verified_intake'};
  }
  async dispatch(event: DutyEvent): Promise<string[]> {
    const state = await this.active();
    if (event.teamId!==this.relay.teamId || !this.setup.channelIds.includes(event.channelId) || this.relay.blockedChannelIds.has(event.channelId) || this.relay.blockedSenderIds.has(event.senderUserId)) return [];
    if (!this.setup.intakeBotIds?.includes(event.senderUserId) || event.messageTs !== event.threadTs) return [];
    if (!this.setup.qaAssigneeNames?.length) throw new Error('duty_assignee_names_not_configured');
    const keys=ticketKeys(event.text), assignee=intakeAssignee(event.text);
    if (keys.length !== 1 || !assignee) {
      const warning={reason:'unrecognized_intake_format',channelId:event.channelId,messageTs:event.messageTs};
      await this.store.set(this.stateKey+':intake-warning',JSON.stringify(warning),32*86400);
      console.warn('duty_intake_warning',warning);
      return [];
    }
    if (!this.setup.qaAssigneeNames.includes(assignee)) return [];
    const key=keys[0]!, marker=`<!-- cs-duty-intake:${key} -->`;
    const lock=this.stateKey+':case:'+key, owner=randomUUID();
    if (!await this.store.setIfAbsent(lock,owner,60)) throw new Error('duty_case_busy');
    try {
      const current=await this.active();
      if(current.revision!==state.revision) throw new Error('duty_session_changed');
      const eventId=`${event.channelId}:${event.messageTs}`,receipt=`${lock}:event:${eventId}`;
      if(await this.store.get(receipt)) return [];
      // ticketId is a receipt namespace for new intakes, not a claimed Jira numeric ID.
      const context: Context={version:1,source:'cs_duty',ticketKey:key,ticketId:key,channelId:event.channelId,threadTs:event.threadTs,revision:state.revision,expiresAt:state.endsAt,eventId,intakeAssignee:assignee};
      const cm=`<!-- duty-event:${eventId} -->`;
      const content=`CS duty case ${key}\nRun cs-duty-policy with this service-verified proof:\nDUTY_PROOF=${this.proof(context)}\nAdmission is based on the trusted Bug Report Bot Assignee at report time. Jira has not been read by the relay. Fetch context and evaluate evidence autonomously. Begin with duty.py check; its result verifies the duty session and reply target, not Jira availability. Reply through cs-duty-reply.`;
      let issue=await findIssue(this.api,marker,this.fetchImpl,key);
      const legacyId=issue?.description?.match(/^<!-- cs-duty:(\d+) -->\n/)?.[1];
      if(legacyId && await this.store.get(`${this.stateKey}:case:${legacyId}:event:${eventId}`)) {
        await this.store.set(receipt,issue!.id,32*86400);
        return [];
      }
      if(!issue) issue=await createIssue(this.api,`[CS Duty] ${key}`,marker+'\n'+cm+'\n'+content,this.fetchImpl);
      else if(!issue.description?.includes(cm) && !await findComment(this.api,issue.id,cm,this.fetchImpl)) await createComment(this.api,issue.id,cm+'\n'+content,this.fetchImpl);
      await this.store.set(receipt,issue.id,32*86400);
      return [issue.id];
    } finally {await this.store.releaseIfOwner(lock,owner);}
  }
  async readiness(): Promise<unknown> {
    const auth=await this.slack('auth.test',{});
    const channels=[];
    for(const id of this.setup.channelIds) {
      const info=await this.slack('conversations.info',{channel:id});
      channels.push({id,member:info.channel?.is_member===true,archived:info.channel?.is_archived===true});
    }
    return {enabled:dutyActive(await this.state()),botIdentityMatches:this.relay.botUserIds.has(auth.user_id),channels,intakeConfigured:!!this.setup.intakeBotIds?.length && !!this.setup.qaAssigneeNames?.length};
  }
  async patrol(): Promise<unknown> {
    if (!dutyActive(await this.state())) return {status:'disabled'};
    const lock=this.stateKey+':patrol-lock',owner=randomUUID();
    if (!await this.store.setIfAbsent(lock,owner,60)) return {status:'busy'};
    let processed=0;
    try {
      for(const channel of this.setup.channelIds) {
        await this.active();
        const key=this.stateKey+':cursor:'+channel,raw=await this.store.get(key);
        // First activation only backfills the previous 15 minutes, never all history.
        const cursor=raw?JSON.parse(raw):{oldest:String(Date.now()/1000-900)};
        cursor.latest ??= String(Date.now()/1000);
        const page=await this.slack('conversations.history',{channel,oldest:cursor.oldest,latest:cursor.latest,limit:20,...(cursor.next?{cursor:cursor.next}:{})});
        for(const m of page.messages??[]) {
          const intakeBot=m.bot_id && this.setup.intakeBotIds?.includes(m.bot_id);
          if((!intakeBot && (!m.user || m.bot_id || m.subtype)) || !ticketKeys(m.text??'').length) continue;
          await this.dispatch({teamId:this.relay.teamId,channelId:channel,senderUserId:intakeBot?m.bot_id:m.user,messageTs:m.ts,threadTs:m.thread_ts??m.ts,text:m.text}); processed++;
        }
        const next=page.response_metadata?.next_cursor;
        if(page.has_more && !next) throw new Error('invalid_patrol_cursor');
        await this.store.set(key,JSON.stringify(next?{...cursor,next}:{oldest:cursor.latest}),32*86400);
      }
      return {status:'ok',processed};
    } finally {await this.store.releaseIfOwner(lock,owner);}
  }
  async action(proof: string, action: string, body: Record<string,unknown>): Promise<unknown> {
    if (!['check','reply'].includes(action)) throw new Error('unsupported_duty_action');
    const checked = await this.check(proof), {context:c} = checked;
    if (action==='check') return checked;
    if (action==='reply') {
      if (typeof body.text!=='string' || !body.text.trim() || body.text.length>12000 || /<!|<@/.test(body.text)) throw new Error('invalid_reply');
      const phase=body.phase??'conclusion';
      if(phase!=='urgent' && phase!=='conclusion') throw new Error('invalid_reply');
      const receipt = `${this.stateKey}:reply:${c.ticketId}:${c.eventId}:${phase}`, owner=randomUUID();
      const previous = await this.store.get(receipt); if(previous) return {status:previous};
      if(!await this.store.setIfAbsent(receipt+':lock',owner,60)) throw new Error('reply_busy');
      try {
        const saved=await this.store.get(receipt); if(saved) return {status:saved};
        await this.check(proof);
        // Mark ambiguous sends before network I/O. Never automatically resend an uncertain write.
        await this.store.set(receipt,'pending',32*86400);
        const r=await this.slack('chat.postMessage',{channel:c.channelId,thread_ts:c.threadTs,text:body.text+(body.notify===true?`\n<@${this.setup.onCallSlackId}> 请接手确认。`:''),unfurl_links:false,unfurl_media:false});
        await this.store.set(receipt,String(r.ts),32*86400);
        return {status:'sent',ts:r.ts};
      } finally {await this.store.releaseIfOwner(receipt+':lock',owner);}
    }
    throw new Error('unsupported_duty_action');
  }
}
