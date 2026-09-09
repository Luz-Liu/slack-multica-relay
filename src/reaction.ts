const SLACK_API_URL = 'https://slack.com/api/reactions.add';

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
