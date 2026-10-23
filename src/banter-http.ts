import { Receiver } from "@upstash/qstash";
import { loadRelayConfig, type RelayConfig } from "./config.js";
import { createComment, createIssue, type ApiConfig } from "./multica-api.js";
import { lookupSlackAuthor } from "./slack-author.js";
import { digest } from "./thread-router.js";
import { UpstashThreadStore, type ThreadStore } from "./thread-store.js";

const SLACK_ID = /^[A-Z][A-Z0-9]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TS = /^\d+\.\d+$/u;
const MAX_TEXT = 2000;
const CONTEXT_MESSAGES = 10;
const MAPPING_TTL_SECONDS = 14 * 24 * 3600;
const LOCK_TTL_SECONDS = 30;
// "03｜<@U123> 带来了…" — a numbered product announcement posted as a thread root.
const PRODUCT_POST = /^\s*\d+\s*[｜|]\s*<@[UW][A-Z0-9]+>/u;

export interface BanterSetup {
  channelIds: string[];
  agentId: string;
  ownerSlackIds: string[];
  projectId?: string;
  productPosterIds?: string[];
  mode: "live" | "test";
}

export interface BanterEvent {
  teamId: string;
  channelId: string;
  senderUserId: string;
  messageTs: string;
  threadTs: string;
  text: string;
  kind?: "product_post";
  addressed?: true;
}

function reply(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || !SLACK_ID.test(x)))
    return undefined;
  return value as string[];
}

/** Disabled (undefined) unless BANTER_SETUP is present and fully valid. */
export function banterSetup(raw: string | undefined): BanterSetup | undefined {
  if (!raw?.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!record(value)) return undefined;
  const channelIds = idList(value.channelIds);
  const ownerSlackIds = idList(value.ownerSlackIds);
  if (!channelIds?.length || !ownerSlackIds?.length) return undefined;
  if (typeof value.agentId !== "string" || !UUID.test(value.agentId)) return undefined;
  if (value.projectId !== undefined && (typeof value.projectId !== "string" || !UUID.test(value.projectId)))
    return undefined;
  if (value.mode !== undefined && value.mode !== "live" && value.mode !== "test") return undefined;
  const productPosterIds = value.productPosterIds === undefined ? undefined : idList(value.productPosterIds);
  if (value.productPosterIds !== undefined && !productPosterIds) return undefined;
  return {
    channelIds,
    ownerSlackIds,
    agentId: value.agentId,
    ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}),
    ...(productPosterIds ? { productPosterIds } : {}),
    mode: value.mode === "test" ? "test" : "live",
  };
}

function consumerHref(relay: RelayConfig): string {
  return new URL("/api/banter/consume", relay.consumerUrl).href;
}

function stripOwnerMentions(text: string, ownerIds: string[]): { text: string; mentioned: boolean } {
  let mentioned = false;
  let out = text;
  for (const id of ownerIds) {
    const pattern = new RegExp(`<@${id}(?:\\|[^>]+)?>`, "gu");
    if (pattern.test(out)) mentioned = true;
    out = out.replace(pattern, " ");
  }
  return { text: out, mentioned };
}

/**
 * Called after Slack signature and envelope checks. Only human thread replies
 * in configured channels are accepted; anything addressed to the normal
 * mention targets keeps its existing routing.
 */
export async function admitBanter(
  body: Record<string, unknown>,
  relay: RelayConfig,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  hasTargetMention: (text: string) => boolean,
): Promise<Response | undefined> {
  const setup = banterSetup(env.BANTER_SETUP);
  const e = body.event;
  if (!setup || !record(e)) return;
  if (body.team_id !== relay.teamId || typeof e.channel !== "string") return;
  if (!setup.channelIds.includes(e.channel) || relay.blockedChannelIds.has(e.channel)) return;
  if (e.subtype !== undefined || e.bot_id !== undefined) return;
  if (typeof e.user !== "string" || typeof e.ts !== "string" || typeof e.text !== "string") return;
  if (setup.ownerSlackIds.includes(e.user) || relay.blockedSenderIds.has(e.user)) return;
  if (!e.text.trim()) return;
  // An @ of the owner alone is someone talking to Luz: banter takes it. Any other
  // configured target (bot, user group) keeps the normal workflow routing.
  const owner = stripOwnerMentions(e.text, setup.ownerSlackIds);
  if (hasTargetMention(owner.text)) return;
  const isRoot = e.thread_ts === undefined || e.thread_ts === e.ts;
  if (isRoot) {
    if (!PRODUCT_POST.test(e.text)) return;
    if (setup.productPosterIds && !setup.productPosterIds.includes(e.user)) return;
  } else if (typeof e.thread_ts !== "string") return;
  const event: BanterEvent = {
    teamId: relay.teamId,
    channelId: e.channel,
    senderUserId: e.user,
    messageTs: e.ts,
    threadTs: isRoot ? e.ts : (e.thread_ts as string),
    text: e.text.slice(0, MAX_TEXT),
    ...(isRoot ? { kind: "product_post" as const } : {}),
    ...(owner.mentioned && !isRoot ? { addressed: true as const } : {}),
  };
  const response = await fetchImpl(`${relay.queueUrl}/v2/publish/${consumerHref(relay)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${relay.queueToken}`,
      "content-type": "application/json",
      "Upstash-Deduplication-Id": digest(`banter:${event.channelId}:${event.messageTs}`),
      "Upstash-Retries": "3",
      "Upstash-Timeout": "50s",
      "Upstash-Flow-Control-Key": digest(`banter:${event.channelId}:${event.threadTs}`),
      "Upstash-Flow-Control-Value": "parallelism=1",
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(1800),
  });
  if (!response.ok) return reply({ error: "banter_queue_unavailable" }, 503);
  return reply({ action: "banter_accepted" });
}

interface SlackMessage {
  ts: string;
  user?: string;
  text: string;
}

async function slackJson(
  method: string,
  params: Record<string, string>,
  token: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetchImpl(
      `https://slack.com/api/${method}?${new URLSearchParams(params)}`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) },
    );
    const body: unknown = await response.json();
    return record(body) && body.ok === true ? body : undefined;
  } catch {
    return undefined;
  }
}

async function displayName(
  userId: string,
  token: string,
  fetchImpl: typeof fetch,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(userId);
  if (cached) return cached;
  const info = await slackJson("users.info", { user: userId }, token, fetchImpl);
  const user = info && record(info.user) ? info.user : undefined;
  const profile = user && record(user.profile) ? user.profile : undefined;
  const pick = [profile?.display_name, profile?.real_name, user?.real_name, user?.name].find(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );
  const name = (pick ?? userId).replace(/\s+/gu, " ").trim();
  cache.set(userId, name);
  return name;
}

async function threadContext(
  event: BanterEvent,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SlackMessage[]> {
  const body = await slackJson(
    "conversations.replies",
    { channel: event.channelId, ts: event.threadTs, limit: "200" },
    token,
    fetchImpl,
  );
  if (!body || !Array.isArray(body.messages)) return [];
  const messages = body.messages.filter(
    (m): m is Record<string, unknown> =>
      record(m) && typeof m.ts === "string" && typeof m.text === "string",
  );
  const root = messages.find((m) => m.ts === event.threadTs);
  const tail = messages.filter((m) => m.ts !== event.threadTs).slice(-CONTEXT_MESSAGES);
  return [...(root ? [root] : []), ...tail].map((m) => ({
    ts: m.ts as string,
    text: (m.text as string).slice(0, MAX_TEXT),
    ...(typeof m.user === "string" ? { user: m.user } : {}),
  }));
}

async function renderMessage(
  message: SlackMessage,
  setup: BanterSetup,
  token: string,
  fetchImpl: typeof fetch,
  cache: Map<string, string>,
): Promise<string> {
  const who = message.user
    ? setup.ownerSlackIds.includes(message.user)
      ? "我（owner，你代发的消息）"
      : await displayName(message.user, token, fetchImpl, cache)
    : "（系统/应用）";
  return `- ${who}（${message.ts}）：${message.text.replace(/\n/gu, " ")}`;
}

async function humanize(
  text: string,
  token: string,
  fetchImpl: typeof fetch,
  cache: Map<string, string>,
): Promise<string> {
  const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/gu)].map((m) => m[1]!))];
  let out = text;
  for (const id of ids.slice(0, 5)) {
    const name = await displayName(id, token, fetchImpl, cache);
    out = out.replaceAll(new RegExp(`<@${id}(?:\\|[^>]+)?>`, "gu"), `@${name}`);
  }
  return out;
}

function apiConfig(relay: RelayConfig, setup: BanterSetup): ApiConfig {
  return {
    ...relay,
    multicaProjectId: setup.projectId ?? relay.multicaProjectId,
    multicaAssigneeType: "agent",
    multicaAssigneeId: setup.agentId,
    multicaThreadScopeId: undefined,
    multicaLegacyAgentId: undefined,
  };
}

async function dispatchBanter(
  event: BanterEvent,
  setup: BanterSetup,
  relay: RelayConfig,
  store: ThreadStore,
  fetchImpl: typeof fetch,
): Promise<{ action: string }> {
  const token = relay.slackReactionToken;
  const api = apiConfig(relay, setup);
  const names = new Map<string, string>();
  const author = await displayName(event.senderUserId, token, fetchImpl, names);
  const bodyText = await humanize(event.text, token, fetchImpl, names);
  const newLine = `- ${author}（${event.messageTs}）：${bodyText.replace(/\n/gu, " ")}`;
  const product = event.kind === "product_post";
  const addressed = event.addressed === true;
  const scope = digest(`${relay.multicaWorkspaceId}:${setup.agentId}`);
  const threadId = digest(`${event.channelId}:${event.threadTs}`);
  const mappingKey = `banter:${scope}:thread:${threadId}`;
  const lockKey = `banter:${scope}:lock:${threadId}`;
  const owner = digest(`${event.messageTs}:${Date.now()}`);
  if (!(await store.setIfAbsent(lockKey, owner, LOCK_TTL_SECONDS))) throw new Error("banter_thread_busy");
  try {
    const existing = await store.get(mappingKey);
    if (existing) {
      await createComment(api, existing, `${product ? "新产品帖" : addressed ? "新消息（@了你，必须马上接话）" : "新消息"}：\n${newLine}`, fetchImpl);
      return { action: "banter_commented" };
    }
    const context = await threadContext(event, token, fetchImpl);
    const lines = await Promise.all(
      context.map((m) => renderMessage(m, setup, token, fetchImpl, names)),
    );
    const description = [
      `banter-thread:${event.channelId}:${event.threadTs}`,
      "thread-banter",
      `channel: ${event.channelId}`,
      `thread_ts: ${event.threadTs}`,
      `mode: ${setup.mode}`,
      ...(product ? ["kind: product_post"] : []),
      ...(addressed ? ["addressed: true"] : []),
      "",
      "## Thread 上下文（旧→新）",
      ...(lines.length ? lines : ["（读取失败，仅有下面的新消息）"]),
      "",
      product ? "## 新产品帖（根消息）" : addressed ? "## 新消息（@了你，必须马上接话）" : "## 新消息",
      newLine,
    ].join("\n");
    const issue = await createIssue(api, `1024 捧哏 · thread ${event.threadTs}`, description, fetchImpl);
    await store.set(mappingKey, issue.id, MAPPING_TTL_SECONDS);
    return { action: "banter_created" };
  } finally {
    await store.releaseIfOwner(lockKey, owner).catch(() => {});
  }
}

function safeError(error: unknown): string {
  const allowed = ["banter_thread_busy", "multica_http_error", "invalid_multica_response", "ambiguous_issue_create"];
  return error instanceof Error && allowed.includes(error.message) ? error.message : "banter_operation_failed";
}

export async function consumeBanter(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  try {
    const relay = loadRelayConfig(env);
    const setup = banterSetup(env.BANTER_SETUP);
    if (!setup) return reply({ action: "disabled" });
    const raw = await request.text();
    if (raw.length > 256 * 1024) return reply({ error: "too_large" }, 413);
    const receiver = new Receiver({
      currentSigningKey: relay.queueCurrentSigningKey,
      nextSigningKey: relay.queueNextSigningKey,
    });
    try {
      const valid = await receiver.verify({
        body: raw,
        signature: request.headers.get("upstash-signature") ?? "",
        url: consumerHref(relay),
      });
      if (!valid) return reply({ error: "invalid_signature" }, 401);
    } catch {
      return reply({ error: "invalid_signature" }, 401);
    }
    const event = JSON.parse(raw) as BanterEvent;
    if (
      event.teamId !== relay.teamId ||
      !setup.channelIds.includes(event.channelId) ||
      relay.blockedChannelIds.has(event.channelId) ||
      typeof event.senderUserId !== "string" ||
      !/^U[A-Z0-9]+$/u.test(event.senderUserId) ||
      setup.ownerSlackIds.includes(event.senderUserId) ||
      relay.blockedSenderIds.has(event.senderUserId) ||
      !TS.test(event.messageTs) ||
      !TS.test(event.threadTs) ||
      (event.messageTs === event.threadTs && event.kind !== "product_post") ||
      (event.kind !== undefined && event.kind !== "product_post") ||
      (event.addressed !== undefined && event.addressed !== true) ||
      (event.kind === "product_post" && !PRODUCT_POST.test(event.text)) ||
      typeof event.text !== "string"
    )
      return reply({ action: "ignored" });
    if ((await lookupSlackAuthor(event.senderUserId, relay.slackReactionToken, fetchImpl)).isBot)
      return reply({ action: "ignored" });
    const store = new UpstashThreadStore(relay.kvRestApiUrl, relay.kvRestApiToken, fetchImpl);
    return reply(await dispatchBanter(event, setup, relay, store, fetchImpl));
  } catch (error) {
    return reply({ error: safeError(error) }, 503);
  }
}
