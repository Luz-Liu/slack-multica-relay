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
    (value.rootPrefilterMention !== undefined && typeof value.rootPrefilterMention !== "boolean")
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
  const consumer = new URL(CONSUME_PATH, relay.consumerUrl).href;
  const response = await fetchImpl(relay.queueUrl + "/v2/publish/" + consumer, {
    method: "POST",
    headers: {
      authorization: `Bearer ${relay.queueToken}`,
      "content-type": "application/json",
      "Upstash-Deduplication-Id": digest("deploy-close:" + event.channelId + ":" + event.messageTs),
      "Upstash-Retries": "3",
      "Upstash-Timeout": "50s",
      "Upstash-Flow-Control-Key": digest("deploy-close:" + event.channelId + ":" + event.threadTs),
      "Upstash-Flow-Control-Value": "parallelism=1",
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(1800),
  });
  if (!response.ok) return Response.json({ error: "deploy_close_queue_unavailable", retryable: true }, { status: 503 });
  console.info("deploy_close_admission", { signal, channelId: event.channelId, messageTs: event.messageTs });
  return Response.json({ action: "deploy_close_accepted", signal });
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

async function fetchRoot(event: DeployCloseEvent, relay: RelayConfig, fetchImpl: typeof fetch): Promise<unknown> {
  const query = new URLSearchParams({ channel: event.channelId, ts: event.threadTs, limit: "1", inclusive: "true" });
  const response = await fetchImpl("https://slack.com/api/conversations.replies?" + query, {
    headers: { authorization: `Bearer ${relay.slackReactionToken}` },
    signal: AbortSignal.timeout(8000),
  });
  const value: unknown = await response.json();
  if (!response.ok || !record(value) || value.ok !== true || !Array.isArray(value.messages))
    throw new Error("deploy_close_root_unavailable");
  return value.messages[0];
}

export async function consumeDeployClose(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status });
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
    event = JSON.parse(raw) as DeployCloseEvent;
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
    const root = await fetchRoot(event, relay, fetchImpl);
    if (!validDeployRoot(root, event.threadTs, setup)) return reply({ action: "ignored", reason: "not_confirm_deploy_root" });
    if (setup.rootPrefilterMention && !rootMentionsOwner(root.text, setup.ownerSlackUserId))
      return reply({ action: "ignored", reason: "owner_not_mentioned" });
    const threadEvent: SlackThreadEvent = {
      teamId: event.teamId,
      channelId: event.channelId,
      messageTs: event.messageTs,
      threadTs: event.threadTs,
      senderUserId: event.senderUserId,
      text: event.text,
      mention: { type: "user", id: setup.ownerSlackUserId },
    };
    const deadline = AbortSignal.timeout(45000);
    const boundedFetch: typeof fetch = (input, init = {}) =>
      fetchImpl(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
    const { multicaThreadScopeId: _scope, multicaLegacyAgentId: _legacy, ...base } = relay;
    const result = await routeSlackThreadEvent(
      threadEvent,
      {
        ...base,
        multicaProjectId: setup.projectId,
        multicaAssigneeType: setup.assigneeType,
        multicaAssigneeId: setup.assigneeId,
        store: new UpstashThreadStore(relay.kvRestApiUrl, relay.kvRestApiToken, boundedFetch),
        formatTitle: (e, scope) => deployCloseTitle(root.text, signal, e, scope),
      },
      boundedFetch,
    );
    console.info("deploy_close_dispatch", { ...result, signal, messageTs: event.messageTs });
    return reply({ ...result, signal });
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : "deploy_close_failed";
    console.warn("deploy_close_dispatch", { reason: code, messageTs: event.messageTs });
    return reply({ error: code, retryable: true }, 503);
  }
}
