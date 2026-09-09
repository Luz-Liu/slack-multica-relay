import { createHash, randomUUID } from "node:crypto";
import {
  ApiError,
  threadScopeId,
  validateMappedIssue,
  createIssue,
  findIssue,
  createComment,
  findComment,
  getSlackReplyContext,
  type ApiConfig,
} from "./multica-api.js";
import type { MentionMatch } from "./mentions.js";
import { type ThreadStore } from "./thread-store.js";
import {
  formatTaskTitle,
  formatTaskDescription,
  readTaskMessage,
} from "./task-presentation.js";

export interface SlackThreadEvent {
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  senderUserId: string;
  text: string;
  mention: MentionMatch;
  files?: unknown;
}
export interface ThreadRouterConfig extends ApiConfig {
  store: ThreadStore;
}
interface ThreadState {
  version: 2;
  rootMessageKey: string;
  issueId?: string;
  creating: boolean;
}
interface MessageState {
  phase: "writing" | "done" | "rejected";
}
export interface ThreadRouteResult {
  action: "created" | "comment_persisted" | "duplicate";
  issueId: string;
}
export const STATE_TTL_SECONDS = 90 * 24 * 60 * 60;
export function threadKey(event: SlackThreadEvent): string {
  return `${event.teamId}:${event.channelId}:${event.threadTs}`;
}
export function messageKey(event: SlackThreadEvent): string {
  return `${event.teamId}:${event.channelId}:${event.messageTs}`;
}
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function routeSlackThreadEvent(
  event: SlackThreadEvent,
  config: ThreadRouterConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ThreadRouteResult> {
  const scope = digest(
    config.multicaWorkspaceId +
      ":" +
      config.multicaProjectId +
      ":" +
      threadScopeId(config),
  );
  const key = `relay:${scope}:thread:${digest(threadKey(event))}`;
  const msgKey = `relay:${scope}:message:${digest(messageKey(event))}`;
  const lockKey = key + ":lock",
    owner = randomUUID();
  if (!(await config.store.setIfAbsent(lockKey, owner, 120)))
    throw new Error("thread_lock_busy");
  try {
    const raw = await config.store.get(key);
    let state: ThreadState;
    if (raw) {
      state = JSON.parse(raw) as ThreadState;
      if (
        state.version !== 2 ||
        typeof state.rootMessageKey !== "string" ||
        typeof state.creating !== "boolean"
      )
        throw new Error("invalid_thread_state");
    } else
      state = {
        version: 2,
        rootMessageKey: messageKey(event),
        creating: false,
      };
    const marker = `<!-- relay-thread:${scope}:${digest(threadKey(event))} -->`;
    if (state.issueId) await validateMappedIssue(config, state.issueId, marker, fetchImpl);
    if (!state.issueId) {
      // Recover by immutable description marker before any write. A POST whose
      // result is unknown must never be repeated blindly.
      const existing = await findIssue(config, marker, fetchImpl);
      if (existing) {
        state.issueId = existing.id;
        if (!raw) {
          const original = readTaskMessage(existing.description!);
          if (
            `${original.teamId}:${original.channelId}:${original.threadTs}` !==
            threadKey(event)
          )
            throw new Error("invalid_thread_state");
          state.rootMessageKey = `${original.teamId}:${original.channelId}:${original.messageTs}`;
        }
      } else {
        if (state.creating) throw new Error("ambiguous_issue_create");
        const replyContext = await getSlackReplyContext(config, fetchImpl);
        state.rootMessageKey = messageKey(event);
        state.creating = true;
        await config.store.set(key, JSON.stringify(state), STATE_TTL_SECONDS);
        try {
          const created = await createIssue(
            config,
            formatTaskTitle(event, scope),
            formatTaskDescription(event, marker, false, replyContext),
            fetchImpl,
          );
          state.issueId = created.id;
        } catch (error) {
          // Definite request rejection permits a later retry; 5xx/transport or
          // malformed success may have committed, so retain the write intent.
          if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500
          ) {
            state.creating = false;
            await config.store.set(
              key,
              JSON.stringify(state),
              STATE_TTL_SECONDS,
            );
          }
          throw error;
        }
      }
      state.creating = false;
      await config.store.set(key, JSON.stringify(state), STATE_TTL_SECONDS);
    }
    const previous = await config.store.get(msgKey);
    if (previous && (JSON.parse(previous) as MessageState).phase === "done")
      return { action: "duplicate", issueId: state.issueId };
    if (messageKey(event) === state.rootMessageKey) {
      await config.store.set(
        msgKey,
        JSON.stringify({ phase: "done" }),
        STATE_TTL_SECONDS,
      );
      return { action: "created", issueId: state.issueId };
    }
    const messageMarker = `<!-- relay-message:${digest(messageKey(event))} -->`;
    const existingComment = await findComment(
      config,
      state.issueId,
      messageMarker,
      fetchImpl,
    );
    if (!existingComment) {
      if (
        previous &&
        (JSON.parse(previous) as MessageState).phase === "writing"
      )
        throw new Error("ambiguous_comment_create");
      const replyContext = await getSlackReplyContext(config, fetchImpl);
      await config.store.set(
        msgKey,
        JSON.stringify({ phase: "writing" }),
        STATE_TTL_SECONDS,
      );
      try {
        await createComment(
          config,
          state.issueId,
          formatTaskDescription(event, messageMarker, true, replyContext),
          fetchImpl,
        );
      } catch (error) {
        // Do not clear ambiguous writes. Explicit rejections are retried by
        // the queue after storing a non-writing phase.
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        )
          await config.store.set(
            msgKey,
            JSON.stringify({ phase: "rejected" }),
            STATE_TTL_SECONDS,
          );
        throw error;
      }
    }
    await config.store.set(
      msgKey,
      JSON.stringify({ phase: "done" }),
      STATE_TTL_SECONDS,
    );
    return { action: "comment_persisted", issueId: state.issueId };
  } finally {
    await config.store.releaseIfOwner(lockKey, owner);
  }
}
