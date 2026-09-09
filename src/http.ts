import { Receiver } from "@upstash/qstash";
import { loadRelayConfig, type RelayConfig } from "./config.js";
import { verifySlackSignature } from "./signature.js";
import {
  findTargetMention,
  isSupportedMessage,
  type SlackMessageEvent,
} from "./mentions.js";
import { addSlackReaction, reactionErrorDetails } from "./reaction.js";
import {
  routeSlackThreadEvent,
  digest,
  threadKey,
  messageKey,
  type SlackThreadEvent,
} from "./thread-router.js";
import { UpstashThreadStore } from "./thread-store.js";

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
async function readBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 256 * 1024) throw new Error("body_too_large");
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts).toString("utf8");
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function admitted(event: SlackThreadEvent, config: RelayConfig): boolean {
  return (
    event.teamId === config.teamId &&
    (config.allowAllChannels || config.allowedChannelIds.has(event.channelId)) &&
    !config.blockedChannelIds.has(event.channelId) &&
    (config.allowAllSenders || config.allowedSenderIds.has(event.senderUserId)) &&
    !config.blockedSenderIds.has(event.senderUserId) &&
    !!findTargetMention(
      event.text,
      config.targetUserIds,
      config.targetSubteamIds,
    )
  );
}
function parsedEvent(value: unknown): SlackThreadEvent {
  if (
    !record(value) ||
    ["teamId", "channelId", "senderUserId"].some(
      (k) =>
        typeof value[k] !== "string" ||
        !/^[A-Z][A-Z0-9]+$/u.test(value[k] as string),
    ) ||
    ["messageTs", "threadTs"].some(
      (k) =>
        typeof value[k] !== "string" || !/^\d+\.\d+$/u.test(value[k] as string),
    ) ||
    typeof value.text !== "string" ||
    !record(value.mention) ||
    !["user", "subteam"].includes(String(value.mention.type)) ||
    typeof value.mention.id !== "string"
  )
    throw new Error("invalid_event");
  return value as unknown as SlackThreadEvent;
}
function reason(error: unknown): string {
  if (
    error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name)
  )
    return "timeout";
  const codes = [
    "body_too_large",
    "invalid_event",
    "thread_lock_busy",
    "ambiguous_issue_create",
    "ambiguous_comment_create",
    "invalid_thread_state",
    "ambiguous_issue_mapping",
    "invalid_issue_scope",
    "issue_lookup_limit",
    "comment_lookup_limit",
    "multica_http_error",
    "invalid_multica_response",
    "invalid_comment_cursor",
  ];
  return error instanceof Error && codes.includes(error.message)
    ? error.message
    : "upstream_failed";
}
export async function acceptSlack(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const start = Date.now();
  if (request.method !== "POST")
    return json({ error: "method_not_allowed" }, 405);
  let config: RelayConfig;
  try {
    config = loadRelayConfig(env);
  } catch {
    return json({ error: "relay_not_configured" }, 500);
  }
  let raw: string;
  try {
    raw = await readBody(request);
  } catch {
    return json({ error: "body_too_large" }, 413);
  }
  if (
    !verifySlackSignature(
      raw,
      request.headers.get("x-slack-request-timestamp") ?? undefined,
      request.headers.get("x-slack-signature") ?? undefined,
      config.signingSecret,
    )
  ) {
    console.warn("relay_admission", {
      reason: "invalid_slack_signature",
      hasTimestamp: request.headers.has("x-slack-request-timestamp"),
      hasSignature: request.headers.has("x-slack-signature"),
      contentType: request.headers.get("content-type") ?? "missing",
      bodyBytes: Buffer.byteLength(raw),
    });
    return json({ error: "invalid_slack_signature" }, 401);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!record(body)) return json({ error: "invalid_envelope" }, 400);
  if (body.type === "url_verification" && typeof body.challenge === "string")
    return json({ challenge: body.challenge });
  if (
    body.type !== "event_callback" ||
    !record(body.event) ||
    !isSupportedMessage(body.event as SlackMessageEvent)
  )
    return json({ action: "ignored" });
  const event = body.event;
  const mention = findTargetMention(
    event.text as string,
    config.targetUserIds,
    config.targetSubteamIds,
  );
  if (!mention) return json({ action: "ignored", reason: "not_addressed" });
  let payload: SlackThreadEvent;
  try {
    payload = parsedEvent({
      teamId: body.team_id,
      channelId: event.channel,
      messageTs: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      senderUserId: event.user,
      text: event.text,
      mention,
      ...(event.files ? { files: event.files } : {}),
    });
  } catch {
    return json({ error: "invalid_event" }, 400);
  }
  if (!admitted(payload, config))
    return json({ action: "ignored", reason: "not_allowed" });
  try {
    const response = await fetchImpl(
      config.queueUrl + "/v2/publish/" + config.consumerUrl,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.queueToken}`,
          "content-type": "application/json",
          "Upstash-Deduplication-Id": digest(
            config.consumerUrl + ":" + messageKey(payload),
          ),
          "Upstash-Retries": "3",
          "Upstash-Timeout": "50s",
          "Upstash-Flow-Control-Key": digest(
            config.consumerUrl + ":" + threadKey(payload),
          ),
          "Upstash-Flow-Control-Value": "parallelism=1",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!response.ok) throw new Error("queue_publish_failed");
    const queued: unknown = await response.json();
    if (!record(queued) || typeof queued.messageId !== "string")
      throw new Error("invalid_queue_response");
    console.info("relay_admission", {
      messageKey: messageKey(payload),
      queueMessageId: queued.messageId,
      durationMs: Date.now() - start,
    });
    return json({ action: "accepted", queueMessageId: queued.messageId });
  } catch (error) {
    console.warn("relay_admission", {
      messageKey: messageKey(payload),
      reason: reason(error),
      durationMs: Date.now() - start,
    });
    return json({ error: "queue_unavailable", retryable: true }, 503);
  }
}
export async function consumeQueue(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "POST")
    return json({ error: "method_not_allowed" }, 405);
  let config: RelayConfig;
  try {
    config = loadRelayConfig(env);
  } catch {
    return json({ error: "relay_not_configured" }, 500);
  }
  let raw: string;
  try {
    raw = await readBody(request);
  } catch {
    return json({ error: "body_too_large" }, 413);
  }
  try {
    const valid = await new Receiver({
      currentSigningKey: config.queueCurrentSigningKey,
      nextSigningKey: config.queueNextSigningKey,
      devMode: false,
    }).verify({
      body: raw,
      signature: request.headers.get("upstash-signature") ?? "",
      url: config.consumerUrl,
    });
    if (!valid) return json({ error: "invalid_queue_signature" }, 401);
  } catch {
    return json({ error: "invalid_queue_signature" }, 401);
  }
  let event: SlackThreadEvent;
  try {
    event = parsedEvent(JSON.parse(raw));
  } catch {
    return json({ error: "invalid_event" }, 400);
  }
  if (!admitted(event, config))
    return json({ action: "ignored", reason: "policy_changed" });
  const start = Date.now(),
    deadline = AbortSignal.timeout(45000);
  const boundedFetch: typeof fetch = (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
    });
  try {
    const result = await routeSlackThreadEvent(
      event,
      {
        ...config,
        store: new UpstashThreadStore(
          config.kvRestApiUrl,
          config.kvRestApiToken,
          boundedFetch,
        ),
      },
      boundedFetch,
    );
    try {
      await addSlackReaction(
        config.slackReactionToken,
        event.channelId,
        event.messageTs,
        config.slackReactionName,
        boundedFetch,
      );
    } catch (error) {
      console.warn("relay_reaction", {
        messageKey: messageKey(event),
        reason: "reaction_failed",
        ...reactionErrorDetails(error),
      });
    }
    console.info("relay_dispatch", {
      ...result,
      messageKey: messageKey(event),
      durationMs: Date.now() - start,
    });
    return json(result);
  } catch (error) {
    const code = reason(error);
    console.warn("relay_dispatch", {
      messageKey: messageKey(event),
      reason: code,
      durationMs: Date.now() - start,
    });
    // Non-2xx leaves retry and exhausted-message retention to QStash. Even
    // ambiguous writes remain visible for reconciliation, never acknowledged away.
    return json({ error: code, retryable: true }, 503);
  }
}
