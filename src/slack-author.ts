const SLACK_USERS_INFO_URL = "https://slack.com/api/users.info";
export const SLACK_AUTHOR_LOOKUP_BUDGET_MS = 700;

export interface SlackAuthor {
  id: string;
  isBot: boolean;
}

export class SlackAuthorLookupError extends Error {
  constructor(readonly code: "request_failed" | "http_error" | "invalid_response") {
    super(code);
    this.name = "SlackAuthorLookupError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the event author through Slack's user object. Source metadata such
 * as bot_id/app_id is intentionally not considered: only user.is_bot is the
 * author classification used by admission.
 */
export async function lookupSlackAuthor(
  userId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackAuthor> {
  const url = `${SLACK_USERS_INFO_URL}?user=${encodeURIComponent(userId)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(SLACK_AUTHOR_LOOKUP_BUDGET_MS),
    });
  } catch {
    throw new SlackAuthorLookupError("request_failed");
  }
  if (!response || response.ok !== true)
    throw new SlackAuthorLookupError("http_error");

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SlackAuthorLookupError("invalid_response");
  }
  if (!record(body) || body.ok !== true || !record(body.user))
    throw new SlackAuthorLookupError("invalid_response");
  if (body.user.id !== userId || typeof body.user.is_bot !== "boolean")
    throw new SlackAuthorLookupError("invalid_response");
  return { id: userId, isBot: body.user.is_bot };
}
