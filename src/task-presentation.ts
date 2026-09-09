import { createHash } from "node:crypto";
import type { SlackThreadEvent } from "./thread-router.js";
import type { SlackReplyContext } from "./multica-api.js";

const PAYLOAD_START = "<!-- relay-payload:v1 -->";
const PAYLOAD_END = "<!-- /relay-payload -->";
const FILE_FIELDS = [
  "id",
  "name",
  "mimetype",
  "size",
  "url_private_download",
  "url_private",
  "permalink",
] as const;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function decodeSlack(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function formatTaskTitle(
  event: SlackThreadEvent,
  scope: string,
): string {
  const pr = event.text.match(
    /https:\/\/github\.com\/[^/\s<>|]+\/([^/\s<>|]+)\/pull\/(\d+)(?=[/?#\s<>|]|$)/,
  );
  const summary = decodeSlack(
    event.text
      .replace(/<@[^>]+>|<!subteam\^[^>]+>/g, "")
      .replace(/<https?:\/\/[^>]+>|https?:\/\/\S+/g, ""),
  )
    .replace(/^\s*cc\b\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const label = summary || (pr ? `${pr[1]} #${pr[2]}` : "自动任务");
  // 同一正文的不同线程或 Agent scope 仍须有不同标题，避免服务端同标题去重。
  const identity = createHash("sha256")
    .update(`${scope}:${event.teamId}:${event.channelId}:${event.threadTs}`)
    .digest("hex")
    .slice(0, 16);
  const chars = Array.from(label);
  return `Slack mention · ${chars.slice(0, 80).join("")}${chars.length > 80 ? "..." : ""} · [${identity}]`;
}

function compactEvent(event: SlackThreadEvent): SlackThreadEvent {
  const { files } = event;
  // Slack 入站字段不具有 Relay 元数据权限，只复制事件白名单。
  const rest: SlackThreadEvent = {
    teamId: event.teamId,
    channelId: event.channelId,
    messageTs: event.messageTs,
    threadTs: event.threadTs,
    senderUserId: event.senderUserId,
    text: event.text,
    mention: { type: event.mention.type, id: event.mention.id },
  };
  if (files === undefined) return rest;
  return {
    ...rest,
    files: Array.isArray(files)
      ? files
          .filter(object)
          .map((file) =>
            Object.fromEntries(
              FILE_FIELDS.flatMap((key) =>
                typeof file[key] === "string" ||
                (key === "size" && typeof file[key] === "number")
                  ? [[key, file[key]]]
                  : [],
              ),
            ),
          )
      : [],
  };
}

function quoteMessage(text: string): string {
  // 原文只作为引用展示，不让消息里的 HTML、围栏或链接语法改写描述结构。
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}()!#|~]/g, "\\$&")
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

export function formatTaskDescription(
  event: SlackThreadEvent,
  marker: string,
  followup = false,
  replyContext?: SlackReplyContext,
): string {
  const payload = compactEvent(event);
  const timestamp = Number(event.messageTs) * 1000;
  const date = new Date(timestamp);
  const time = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(date) + "（Asia/Shanghai）"
    : "未知";
  const channelUrl =
    "https://slack.com/app_redirect?" +
    new URLSearchParams({
      team: event.teamId,
      channel: event.channelId,
    });
  const json = JSON.stringify(
    { eventPayload: payload, ...(replyContext ? { replyContext } : {}) },
    null,
    2,
  );
  const fence = "`".repeat(
    (json.match(/`+/g) ?? []).reduce(
      (length, run) => Math.max(length, run.length + 1),
      3,
    ),
  );
  return [
    marker,
    followup ? "## Slack thread 后续消息" : "## Slack 原始消息",
    quoteMessage(decodeSlack(event.text)),
    "## 来源",
    `- Slack 频道：[打开频道](${channelUrl})`,
    `- 触发时间：${time}`,
    `- 附件：${Array.isArray(payload.files) ? payload.files.length : 0} 个`,
    "## 事件上下文",
    PAYLOAD_START,
    `${fence}json\n${json}\n${fence}`,
    PAYLOAD_END,
  ]
    .join("\n\n")
    .replace(marker + "\n\n", marker + "\n");
}

export interface RecoveredMessage {
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
}

export function readTaskMessage(description: string): RecoveredMessage {
  const body = description
    .slice(description.indexOf("\n") + 1)
    .replace(/\r\n/g, "\n");
  let json = body;
  const lines = body.split("\n");
  const starts = lines.filter((line) => line === PAYLOAD_START);
  const ends = lines.filter((line) => line === PAYLOAD_END);
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1)
      throw new Error("invalid_thread_state");
    const start = lines.indexOf(PAYLOAD_START);
    const end = lines.indexOf(PAYLOAD_END);
    const block = lines
      .slice(start + 1, end)
      .join("\n")
      .trim();
    const match = block.match(/^(`{3,})json\n([\s\S]*)\n\1$/);
    if (end < start || !match) throw new Error("invalid_thread_state");
    json = match[2];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("invalid_thread_state");
  }
  const event = object(parsed) ? parsed.eventPayload : undefined;
  if (
    !object(event) ||
    !["teamId", "channelId", "threadTs", "messageTs"].every(
      (key) => typeof event[key] === "string" && event[key].length > 0,
    ) ||
    !/^\d+\.\d+$/.test(event.threadTs as string) ||
    !/^\d+\.\d+$/.test(event.messageTs as string)
  )
    throw new Error("invalid_thread_state");
  return event as unknown as RecoveredMessage;
}
