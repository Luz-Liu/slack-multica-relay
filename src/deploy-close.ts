import { createHash } from "node:crypto";
import { Receiver } from "@upstash/qstash";
import { loadRelayConfig, type RelayConfig } from "./config.js";
import { UpstashThreadStore } from "./thread-store.js";
import {
  digest,
  routeSlackThreadEvent,
  type SlackThreadEvent,
} from "./thread-router.js";

/**
 * 发布后关单（P1：只建卡询问）。DEPLOY_CLOSE_SETUP 未配置或非法时整体关闭，
 * 入站行为与原链路完全一致。只放行白名单频道里指定 GitHub Actions bot 在
 * Confirm Deploy thread 中发出的精确成功/失败文案。
 */
export interface DeployCloseSetup {
  channelIds: string[];
  signalBotIds: string[];
  signalUserIds: string[];
  successTexts: string[];
  failedTexts: string[];
  ownerSlackUserId: string;
  rootPrefilterMention: boolean;
  projectId: string;
  assigneeType: "agent" | "squad";
  assigneeId: string;
  askBotUserId?: string;
  confirmReaction: string;
  askMarker: string;
}
export type DeploySignal = "success" | "failed";
export interface DeployCloseEvent {
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  senderUserId: string;
  botId: string;
  text: string;
}

const SLACK_ID = /^[A-Z][A-Z0-9]+$/u;
const TS = /^\d+\.\d+$/u;
const EMOJI_NAME = /^[a-z0-9_+\-]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// 只认首行标题里的环境，避免单号标题里出现 "(production)" 误判。
const PRODUCTION_HEADER = /^[^\n]*Confirm Deploy:\s*<[^>\n]+>\s*\(production\)/u;
const CONSUME_PATH = "/api/deploy-close/consume";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some((x) => typeof x !== "string" || !SLACK_ID.test(x)))
    throw new Error("invalid_deploy_close_setup");
  return [...value] as string[];
}
function texts(value: unknown, optional = false): string[] {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || (!optional && !value.length) || value.some((x) => typeof x !== "string" || !x.trim() || x.trim() !== x))
    throw new Error("invalid_deploy_close_setup");
  return [...value] as string[];
}

/** 解析开关；未设置返回 undefined，格式错误抛错（调用方按关闭处理）。 */
export function deployCloseSetup(raw: string | undefined): DeployCloseSetup | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!record(value)) throw new Error("invalid_deploy_close_setup");
  const assigneeType = value.assigneeType ?? "agent";
  if (
    (assigneeType !== "agent" && assigneeType !== "squad") ||
    typeof value.ownerSlackUserId !== "string" || !SLACK_ID.test(value.ownerSlackUserId) ||
    typeof value.projectId !== "string" || !UUID.test(value.projectId) ||
    typeof value.assigneeId !== "string" || !UUID.test(value.assigneeId) ||
    (value.rootPrefilterMention !== undefined && typeof value.rootPrefilterMention !== "boolean") ||
    (value.askBotUserId !== undefined && (typeof value.askBotUserId !== "string" || !SLACK_ID.test(value.askBotUserId))) ||
    (value.confirmReaction !== undefined && (typeof value.confirmReaction !== "string" || !EMOJI_NAME.test(value.confirmReaction))) ||
    (value.askMarker !== undefined && (typeof value.askMarker !== "string" || !value.askMarker.trim() || value.askMarker.trim() !== value.askMarker))
  )
    throw new Error("invalid_deploy_close_setup");
  return {
    channelIds: ids(value.channelIds),
    signalBotIds: ids(value.signalBotIds),
    signalUserIds: ids(value.signalUserIds),
    successTexts: texts(value.successTexts),
    failedTexts: texts(value.failedTexts, true),
    ownerSlackUserId: value.ownerSlackUserId,
    rootPrefilterMention: value.rootPrefilterMention ?? true,
    projectId: value.projectId,
    assigneeType,
    assigneeId: value.assigneeId,
    ...(value.askBotUserId !== undefined ? { askBotUserId: value.askBotUserId } : {}),
    confirmReaction: value.confirmReaction ?? "white_check_mark",
    askMarker: value.askMarker ?? "[deploy-close:v1]",
  };
}
function loadSetup(env: NodeJS.ProcessEnv): DeployCloseSetup | undefined {
  try {
    return deployCloseSetup(env.DEPLOY_CLOSE_SETUP);
  } catch {
    console.warn("deploy_close", { reason: "invalid_deploy_close_setup" });
    return undefined;
  }
}

/** 纯字段匹配：全部满足才返回信号，其余一律 undefined（交回原有流程）。 */
export function matchDeploySignal(
  teamId: unknown,
  event: Record<string, unknown>,
  relay: Pick<RelayConfig, "teamId" | "blockedChannelIds" | "blockedSenderIds">,
  setup: DeployCloseSetup,
): DeploySignal | undefined {
  if (
    teamId !== relay.teamId ||
    event.type !== "message" ||
    event.subtype !== undefined ||
    typeof event.channel !== "string" ||
    !setup.channelIds.includes(event.channel) ||
    relay.blockedChannelIds.has(event.channel) ||
    typeof event.bot_id !== "string" ||
    !setup.signalBotIds.includes(event.bot_id) ||
    typeof event.user !== "string" ||
    !setup.signalUserIds.includes(event.user) ||
    relay.blockedSenderIds.has(event.user) ||
    relay.blockedSenderIds.has(event.bot_id) ||
    typeof event.ts !== "string" ||
    !TS.test(event.ts) ||
    typeof event.thread_ts !== "string" ||
    !TS.test(event.thread_ts) ||
    event.thread_ts === event.ts ||
    typeof event.text !== "string"
  )
    return undefined;
  const text = event.text.trim();
  if (setup.successTexts.includes(text)) return "success";
  if (setup.failedTexts.includes(text)) return "failed";
  return undefined;
}

async function publishDeployClose(
  relay: RelayConfig,
  fetchImpl: typeof fetch,
  body: unknown,
  deduplicationId: string,
  flowControlKey: string,
): Promise<boolean> {
  const consumer = new URL(CONSUME_PATH, relay.consumerUrl).href;
  const response = await fetchImpl(relay.queueUrl + "/v2/publish/" + consumer, {
    method: "POST",
    headers: {
      authorization: `Bearer ${relay.queueToken}`,
      "content-type": "application/json",
      "Upstash-Deduplication-Id": deduplicationId,
      "Upstash-Retries": "3",
      "Upstash-Timeout": "50s",
      "Upstash-Flow-Control-Key": flowControlKey,
      "Upstash-Flow-Control-Value": "parallelism=1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1800),
  });
  return response.ok;
}

/** 在原有 mention/bot 过滤之前调用；只对精确命中的信号生效。 */
export async function admitDeployClose(
  body: Record<string, unknown>,
  relay: RelayConfig,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<Response | undefined> {
  const setup = loadSetup(env);
  if (!setup || !record(body.event)) return undefined;
  const e = body.event;
  const signal = matchDeploySignal(body.team_id, e, relay, setup);
  if (!signal) return undefined;
  const event: DeployCloseEvent = {
    teamId: relay.teamId,
    channelId: e.channel as string,
    messageTs: e.ts as string,
    threadTs: e.thread_ts as string,
    senderUserId: e.user as string,
    botId: e.bot_id as string,
    text: (e.text as string).trim(),
  };
  const published = await publishDeployClose(
    relay,
    fetchImpl,
    event,
    digest("deploy-close:" + event.channelId + ":" + event.messageTs),
    digest("deploy-close:" + event.channelId + ":" + event.threadTs),
  );
  if (!published) return Response.json({ error: "deploy_close_queue_unavailable", retryable: true }, { status: 503 });
  console.info("deploy_close_admission", { signal, channelId: event.channelId, messageTs: event.messageTs });
  return Response.json({ action: "deploy_close_accepted", signal });
}

export interface DeployConfirm {
  channelId: string;
  askTs: string;
  user: string;
  reaction: string;
  eventTs: string;
}

/** 纯字段匹配：owner 在 bot 询问消息上点确认表情，全部满足才返回。 */
export function matchDeployConfirm(
  teamId: unknown,
  event: Record<string, unknown>,
  relay: Pick<RelayConfig, "teamId" | "blockedChannelIds" | "blockedSenderIds">,
  setup: DeployCloseSetup,
): DeployConfirm | undefined {
  const item = event.item;
  if (
    teamId !== relay.teamId ||
    event.type !== "reaction_added" ||
    setup.askBotUserId === undefined ||
    event.reaction !== setup.confirmReaction ||
    event.user !== setup.ownerSlackUserId ||
    relay.blockedSenderIds.has(event.user) ||
    event.item_user !== setup.askBotUserId ||
    !record(item) ||
    item.type !== "message" ||
    typeof item.channel !== "string" ||
    !setup.channelIds.includes(item.channel) ||
    relay.blockedChannelIds.has(item.channel) ||
    typeof item.ts !== "string" ||
    !TS.test(item.ts) ||
    typeof event.event_ts !== "string" ||
    !TS.test(event.event_ts)
  )
    return undefined;
  return { channelId: item.channel, askTs: item.ts, user: event.user, reaction: event.reaction, eventTs: event.event_ts };
}

/** reaction_added 入口：不匹配一律 ignored，不产生任何外部调用。 */
export async function admitDeployConfirm(
  body: Record<string, unknown>,
  relay: RelayConfig,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const setup = loadSetup(env);
  const confirm = setup && matchDeployConfirm(body.team_id, body.event as Record<string, unknown>, relay, setup);
  if (!confirm) return Response.json({ action: "ignored" });
  const published = await publishDeployClose(
    relay,
    fetchImpl,
    { kind: "confirm", teamId: relay.teamId, event: body.event },
    digest(`deploy-close:reaction:${confirm.channelId}:${confirm.askTs}:${confirm.user}:${confirm.reaction}`),
    digest(`deploy-close:${confirm.channelId}:${confirm.askTs}`),
  );
  if (!published) return Response.json({ error: "deploy_close_queue_unavailable", retryable: true }, { status: 503 });
  console.info("deploy_close_admission", { signal: "confirm", channelId: confirm.channelId, messageTs: confirm.askTs });
  return Response.json({ action: "deploy_close_accepted", signal: "confirm" });
}

export interface DeployRoot {
  ts: string;
  text: string;
}
/** 根帖必须是同一 bot 发出的 Confirm Deploy (production)。 */
export function validDeployRoot(root: unknown, threadTs: string, setup: DeployCloseSetup): root is DeployRoot {
  return (
    record(root) &&
    root.ts === threadTs &&
    typeof root.bot_id === "string" &&
    setup.signalBotIds.includes(root.bot_id) &&
    typeof root.text === "string" &&
    PRODUCTION_HEADER.test(root.text)
  );
}
export function rootMentionsOwner(text: string, owner: string): boolean {
  return new RegExp(`<@${owner}(?:\\|[^>]*)?>`, "u").test(text);
}
/** 标题带仓库与 run 号，并保留线程身份哈希，避免服务端同标题去重。 */
export function deployCloseTitle(rootText: string, signal: DeploySignal, event: SlackThreadEvent, scope: string): string {
  const repo = rootText.match(/Confirm Deploy:\s*<[^|>]+\|([^>]+)>/u)?.[1]?.trim() ?? "unknown";
  const identity = createHash("sha256")
    .update(`${scope}:${event.teamId}:${event.channelId}:${event.threadTs}`)
    .digest("hex")
    .slice(0, 16);
  return `Deploy close · ${Array.from(repo).slice(0, 60).join("")}${signal === "failed" ? " · failed" : ""} · [${identity}]`;
}

async function fetchReplies(
  query: Record<string, string>,
  relay: RelayConfig,
  fetchImpl: typeof fetch,
): Promise<unknown[]> {
  const response = await fetchImpl("https://slack.com/api/conversations.replies?" + new URLSearchParams(query), {
    headers: { authorization: `Bearer ${relay.slackReactionToken}` },
    signal: AbortSignal.timeout(8000),
  });
  const value: unknown = await response.json();
  if (!response.ok || !record(value) || value.ok !== true || !Array.isArray(value.messages))
    throw new Error("deploy_close_slack_unavailable");
  return value.messages;
}

function reply(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

/** 复用 thread→issue 路由，在专用 project 下写入 issue / 评论。 */
async function dispatch(
  threadEvent: SlackThreadEvent,
  rootText: string,
  signal: DeploySignal,
  relay: RelayConfig,
  setup: DeployCloseSetup,
  fetchImpl: typeof fetch,
  requireExistingIssue = false,
) {
  const deadline = AbortSignal.timeout(45000);
  const boundedFetch: typeof fetch = (input, init = {}) =>
    fetchImpl(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
  const { multicaThreadScopeId: _scope, multicaLegacyAgentId: _legacy, ...base } = relay;
  return routeSlackThreadEvent(
    threadEvent,
    {
      ...base,
      multicaProjectId: setup.projectId,
      multicaAssigneeType: setup.assigneeType,
      multicaAssigneeId: setup.assigneeId,
      store: new UpstashThreadStore(relay.kvRestApiUrl, relay.kvRestApiToken, boundedFetch),
      formatTitle: (e, scope) => deployCloseTitle(rootText, signal, e, scope),
      requireExistingIssue,
    },
    boundedFetch,
  );
}

function failure(error: unknown, messageTs: string): Response {
  const code = error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : "deploy_close_failed";
  console.warn("deploy_close_dispatch", { reason: code, messageTs });
  return reply({ error: code, retryable: true }, 503);
}

async function consumeConfirm(
  payload: Record<string, unknown>,
  relay: RelayConfig,
  setup: DeployCloseSetup,
  fetchImpl: typeof fetch,
): Promise<Response> {
  // 配置可能在排队期间变化：按当前配置重新做同一组精确匹配。
  const confirm = record(payload.event) ? matchDeployConfirm(payload.teamId, payload.event, relay, setup) : undefined;
  if (!confirm) return reply({ action: "ignored", reason: "policy_changed" });
  try {
    const messages = await fetchReplies(
      { channel: confirm.channelId, ts: confirm.askTs, oldest: confirm.askTs, latest: confirm.askTs, inclusive: "true", limit: "10" },
      relay,
      fetchImpl,
    );
    const ask = messages.find((m) => record(m) && m.ts === confirm.askTs);
    if (
      !record(ask) ||
      ask.user !== setup.askBotUserId ||
      typeof ask.text !== "string" ||
      !ask.text.includes(setup.askMarker) ||
      typeof ask.thread_ts !== "string" ||
      !TS.test(ask.thread_ts) ||
      ask.thread_ts === confirm.askTs
    )
      return reply({ action: "ignored", reason: "not_ask_message" });
    const [root] = await fetchReplies(
      { channel: confirm.channelId, ts: ask.thread_ts, limit: "1", inclusive: "true" },
      relay,
      fetchImpl,
    );
    if (!validDeployRoot(root, ask.thread_ts, setup)) return reply({ action: "ignored", reason: "not_confirm_deploy_root" });
    const result = await dispatch(
      {
        teamId: relay.teamId,
        channelId: confirm.channelId,
        messageTs: confirm.askTs,
        threadTs: ask.thread_ts,
        senderUserId: confirm.user,
        text: "✅ confirmed deploy-close ask",
        mention: { type: "user", id: setup.ownerSlackUserId },
        dedupKey: `reaction:${confirm.askTs}:${confirm.user}:${confirm.reaction}`,
        deployClose: { phase: "confirm", confirmedBy: confirm.user, askTs: confirm.askTs, reactionEventTs: confirm.eventTs },
      },
      root.text,
      "success",
      relay,
      setup,
      fetchImpl,
      true,
    );
    console.info("deploy_close_dispatch", { ...result, phase: "confirm", messageTs: confirm.askTs });
    return reply({ ...result, phase: "confirm" });
  } catch (error) {
    if (error instanceof Error && error.message === "no_thread_issue")
      return reply({ action: "ignored", reason: "no_ask_issue" });
    return failure(error, confirm.askTs);
  }
}

export async function consumeDeployClose(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  let relay: RelayConfig;
  try {
    relay = loadRelayConfig(env);
  } catch {
    return reply({ error: "relay_not_configured" }, 500);
  }
  const setup = loadSetup(env);
  if (!setup) return reply({ action: "disabled" });
  const raw = await request.text();
  if (raw.length > 64 * 1024) return reply({ error: "too_large" }, 413);
  try {
    const valid = await new Receiver({
      currentSigningKey: relay.queueCurrentSigningKey,
      nextSigningKey: relay.queueNextSigningKey,
      devMode: false,
    }).verify({ body: raw, signature: request.headers.get("upstash-signature") ?? "", url: new URL(CONSUME_PATH, relay.consumerUrl).href });
    if (!valid) return reply({ error: "invalid_signature" }, 401);
  } catch {
    return reply({ error: "invalid_signature" }, 401);
  }
  let event: DeployCloseEvent;
  try {
    const payload: unknown = JSON.parse(raw);
    // 旧排队消息没有 kind，按 signal 处理。
    if (record(payload) && payload.kind === "confirm") return consumeConfirm(payload, relay, setup, fetchImpl);
    event = payload as DeployCloseEvent;
  } catch {
    return reply({ error: "invalid_event" }, 400);
  }
  // 配置可能在排队期间变化：按当前配置重新做同一组精确匹配。
  const signal = record(event)
    ? matchDeploySignal(event.teamId, {
        type: "message",
        channel: event.channelId,
        bot_id: event.botId,
        user: event.senderUserId,
        ts: event.messageTs,
        thread_ts: event.threadTs,
        text: event.text,
      }, relay, setup)
    : undefined;
  if (!signal) return reply({ action: "ignored", reason: "policy_changed" });
  try {
    const [root] = await fetchReplies(
      { channel: event.channelId, ts: event.threadTs, limit: "1", inclusive: "true" },
      relay,
      fetchImpl,
    );
    if (!validDeployRoot(root, event.threadTs, setup)) return reply({ action: "ignored", reason: "not_confirm_deploy_root" });
    if (setup.rootPrefilterMention && !rootMentionsOwner(root.text, setup.ownerSlackUserId))
      return reply({ action: "ignored", reason: "owner_not_mentioned" });
    const result = await dispatch(
      {
        teamId: event.teamId,
        channelId: event.channelId,
        messageTs: event.messageTs,
        threadTs: event.threadTs,
        senderUserId: event.senderUserId,
        text: event.text,
        mention: { type: "user", id: setup.ownerSlackUserId },
        deployClose: { phase: "ask" },
      },
      root.text,
      signal,
      relay,
      setup,
      fetchImpl,
    );
    console.info("deploy_close_dispatch", { ...result, signal, messageTs: event.messageTs });
    return reply({ ...result, signal });
  } catch (error) {
    return failure(error, event.messageTs);
  }
}
