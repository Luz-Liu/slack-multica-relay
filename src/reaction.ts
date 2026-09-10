import type { ThreadStore } from "./thread-store.js";

const SLACK_API_URL = 'https://slack.com/api/reactions.add';
export const REACTION_ATTEMPT_BUDGET_MS = 750;
export const REACTION_STATE_TTL_SECONDS = 90 * 24 * 60 * 60;

export class SlackReactionError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number) {
    super(code);
    this.name = 'SlackReactionError';
  }
}

// Log only known API codes, never response bodies or arbitrary exception messages.
const SLACK_ERRORS = new Set([
  'invalid_name', 'missing_scope', 'not_authed', 'invalid_auth', 'token_revoked',
  'token_expired', 'account_inactive', 'channel_not_found', 'not_in_channel',
  'message_not_found', 'no_item_specified', 'too_many_emoji', 'too_many_reactions',
  'ratelimited', 'access_denied', 'restricted_action', 'is_archived',
  'ekm_access_denied', 'org_login_required', 'internal_error', 'fatal_error',
]);

export function reactionErrorDetails(error: unknown) {
  if (error instanceof SlackReactionError) {
    return { errorCode: error.code, httpStatus: error.httpStatus };
  }
  return {
    errorCode: error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
      ? 'request_timeout' : 'network_error',
  };
}

export async function addSlackReaction(
  token: string,
  channelId: string,
  messageTs: string,
  reactionName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(SLACK_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: channelId,
      timestamp: messageTs,
      name: reactionName,
    }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new SlackReactionError('http_error', response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SlackReactionError('invalid_response', response.status);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SlackReactionError('invalid_response', response.status);
  }
  const result = body as { ok?: unknown; error?: unknown };
  if (result.ok === true || result.error === 'already_reacted') return;
  throw new SlackReactionError(
    typeof result.error === 'string' && SLACK_ERRORS.has(result.error)
      ? result.error : 'unknown_error',
    response.status,
  );
}

/**
 * Add the acknowledgement reaction at most once for a message. The KV marker
 * is written durably before the Slack request, so an ambiguous or failed
 * request can never cause a later delivery to add a late reaction. A
 * competing delivery waits for the first bounded attempt before dispatching.
 */
export async function ensureSlackReaction(
  stateKey: string,
  token: string,
  channelId: string,
  messageTs: string,
  reactionName: string,
  store: ThreadStore,
  fetchImpl: typeof fetch = fetch,
): Promise<"reacted" | "skipped"> {
  const attemptedAtMs = Date.now();
  const marker = JSON.stringify({ attemptedAtMs });
  if (!await store.setIfAbsent(stateKey, marker, REACTION_STATE_TTL_SECONDS)) {
    const existing = await store.get(stateKey);
    let existingAttemptedAtMs: number | undefined;
    try {
      const parsed: unknown = existing ? JSON.parse(existing) : undefined;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as { attemptedAtMs?: unknown }).attemptedAtMs === "number"
      )
        existingAttemptedAtMs = (parsed as { attemptedAtMs: number }).attemptedAtMs;
    } catch {
      // A legacy marker still means the attempt was already claimed. It does
      // not carry an active-attempt timestamp, so no additional wait is needed.
    }
    const remaining = existingAttemptedAtMs === undefined ||
      !Number.isFinite(existingAttemptedAtMs)
      ? 0
      : Math.min(
        REACTION_ATTEMPT_BUDGET_MS,
        Math.max(0, attemptedAtMs + REACTION_ATTEMPT_BUDGET_MS - Date.now()),
        Math.max(0, existingAttemptedAtMs + REACTION_ATTEMPT_BUDGET_MS - Date.now()),
      );
    if (remaining > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    return "skipped";
  }
  await addSlackReaction(
    token,
    channelId,
    messageTs,
    reactionName,
    fetchImpl,
  );
  return "reacted";
}
