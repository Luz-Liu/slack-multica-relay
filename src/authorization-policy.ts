import { createHmac } from "node:crypto";

export const RELAY_INTENTS = [
  "cs_investigation",
  "jira_transfer",
  "jira_assign",
  "code_fix",
  "pr_review",
  "direct_reply",
  "summarize",
  "general_task",
] as const;

export const RELAY_ACTIONS = [
  "slack.read",
  "slack.reply",
  "slack.react",
  "jira.read",
  "jira.transfer",
  "jira.assign",
  "telemetry.read",
  "code.read",
  "code.modify",
  "git.commit",
  "git.push",
  "github.pr.create",
  "github.review.comment",
  "github.review.approve",
] as const;

export type RelayIntent = (typeof RELAY_INTENTS)[number];
export type RelayAction = (typeof RELAY_ACTIONS)[number];

export interface AuthorizationPolicyProfile {
  id: string;
  intents: RelayIntent[];
  actions: RelayAction[];
  channelIds?: string[];
  senderIds?: string[];
  mentionTargetIds?: string[];
  assigneeAccountId?: string;
  handoffSlackUserId?: string;
  resumeSenderIds?: string[];
}

export interface AuthorizationPolicy {
  version: 1;
  policyId: string;
  requesterMappings: Record<string, string>;
  profiles: AuthorizationPolicyProfile[];
}

export interface AuthorizationEvent {
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  senderUserId: string;
  text: string;
  mention: { type: "user" | "subteam"; id: string };
}

export interface AuthorizationContextProfile {
  id: string;
  intents: RelayIntent[];
  allowedActions: RelayAction[];
  assigneeAccountId?: string;
  handoffTarget?: { slackUserId: string };
  resumeEligible: boolean;
}

export interface AuthorizationContext {
  version: 1;
  source: "relay_policy";
  policyId: string;
  eventKey: string;
  event: {
    teamId: string;
    channelId: string;
    messageTs: string;
    threadTs: string;
    senderUserId: string;
    text: string;
    mention: { type: "user" | "subteam"; id: string };
  };
  requester: { slackUserId: string; jiraAccountId?: string };
  profiles: AuthorizationContextProfile[];
}

export interface AuthorizationProof {
  algorithm: "hmac-sha256";
  payload: string;
  signature: string;
}

const NO_POLICY: AuthorizationPolicy = {
  version: 1,
  policyId: "disabled",
  requesterMappings: {},
  profiles: [],
};

const POLICY_ERROR = "invalid_authorization_policy";
const SLACK_ID = /^[A-Z][A-Z0-9]+$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function failPolicy(): never {
  throw new Error(POLICY_ERROR);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    failPolicy();
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function slackId(value: unknown): value is string {
  return text(value) && SLACK_ID.test(value);
}

function uniqueStringArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] {
  if (!Array.isArray(value)) return failPolicy();
  const result: T[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !text(item) ||
      !allowed.includes(item as T) ||
      seen.has(item)
    )
      return failPolicy();
    seen.add(item);
    result.push(item as T);
  }
  return result;
}

function slackIdArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => !slackId(item)))
    return failPolicy();
  const result = value as string[];
  if (new Set(result).size !== result.length) return failPolicy();
  return [...result];
}

function optionalSlackIdArray(
  value: Record<string, unknown>,
  key: string,
): string[] | undefined {
  return Object.hasOwn(value, key) ? slackIdArray(value[key]) : undefined;
}

function parseProfile(value: unknown): AuthorizationPolicyProfile {
  if (!record(value)) return failPolicy();
  exactKeys(
    value,
    ["id", "intents", "actions"],
    [
      "channelIds",
      "senderIds",
      "mentionTargetIds",
      "assigneeAccountId",
      "handoffSlackUserId",
      "resumeSenderIds",
    ],
  );
  if (!text(value.id)) return failPolicy();
  const result: AuthorizationPolicyProfile = {
    id: value.id,
    intents: uniqueStringArray(value.intents, RELAY_INTENTS),
    actions: uniqueStringArray(value.actions, RELAY_ACTIONS),
  };
  const channelIds = optionalSlackIdArray(value, "channelIds");
  const senderIds = optionalSlackIdArray(value, "senderIds");
  const mentionTargetIds = optionalSlackIdArray(value, "mentionTargetIds");
  const resumeSenderIds = optionalSlackIdArray(value, "resumeSenderIds");
  if (channelIds !== undefined) result.channelIds = channelIds;
  if (senderIds !== undefined) result.senderIds = senderIds;
  if (mentionTargetIds !== undefined) result.mentionTargetIds = mentionTargetIds;
  if (resumeSenderIds !== undefined) result.resumeSenderIds = resumeSenderIds;
  if (Object.hasOwn(value, "assigneeAccountId")) {
    if (!text(value.assigneeAccountId)) return failPolicy();
    result.assigneeAccountId = value.assigneeAccountId;
  }
  if (Object.hasOwn(value, "handoffSlackUserId")) {
    if (!slackId(value.handoffSlackUserId)) return failPolicy();
    result.handoffSlackUserId = value.handoffSlackUserId;
  }
  return result;
}

function parseRequesterMappings(value: unknown): Record<string, string> {
  if (!record(value)) return failPolicy();
  const result: Record<string, string> = {};
  for (const [slackUserId, jiraAccountId] of Object.entries(value)) {
    if (!slackId(slackUserId) || !text(jiraAccountId)) return failPolicy();
    result[slackUserId] = jiraAccountId;
  }
  return result;
}

/** Parse policy JSON without ever including configuration contents in errors. */
export function parseAuthorizationPolicy(
  raw: string | undefined,
): AuthorizationPolicy {
  if (raw === undefined || raw.trim() === "") return NO_POLICY;
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return failPolicy();
  }
  if (!record(input)) return failPolicy();
  exactKeys(input, ["version", "policyId", "profiles"], ["requesterMappings"]);
  if (input.version !== 1 || !text(input.policyId) || !Array.isArray(input.profiles))
    return failPolicy();
  const profiles = input.profiles.map(parseProfile);
  const ids = profiles.map((profile) => profile.id);
  if (new Set(ids).size !== ids.length) return failPolicy();
  const requesterMappings = Object.hasOwn(input, "requesterMappings")
    ? parseRequesterMappings(input.requesterMappings)
    : {};
  return {
    version: 1,
    policyId: input.policyId,
    requesterMappings,
    profiles,
  };
}

function filterMatches(values: string[] | undefined, actual: string): boolean {
  return values === undefined || values.includes(actual);
}

/** Build the Agent-visible authorization projection from trusted server policy and event identity. */
export function buildAuthorizationContext(
  event: AuthorizationEvent,
  policy: AuthorizationPolicy | undefined,
): AuthorizationContext {
  const activePolicy = policy ?? NO_POLICY;
  const requester: AuthorizationContext["requester"] = {
    slackUserId: event.senderUserId,
  };
  const jiraAccountId = activePolicy.requesterMappings[event.senderUserId];
  if (jiraAccountId) requester.jiraAccountId = jiraAccountId;
  const profiles = activePolicy.profiles
    .filter(
      (profile) =>
        filterMatches(profile.channelIds, event.channelId) &&
        filterMatches(profile.senderIds, event.senderUserId) &&
        filterMatches(profile.mentionTargetIds, event.mention.id),
    )
    .map((profile): AuthorizationContextProfile => {
      const projected: AuthorizationContextProfile = {
        id: profile.id,
        intents: [...profile.intents],
        allowedActions: [...profile.actions],
        resumeEligible: profile.resumeSenderIds?.includes(event.senderUserId) ?? false,
      };
      if (profile.assigneeAccountId)
        projected.assigneeAccountId = profile.assigneeAccountId;
      if (profile.handoffSlackUserId)
        projected.handoffTarget = { slackUserId: profile.handoffSlackUserId };
      return projected;
    });
  return {
    version: 1,
    source: "relay_policy",
    policyId: activePolicy.policyId,
    eventKey: `${event.teamId}:${event.channelId}:${event.messageTs}`,
    event: {
      teamId: event.teamId,
      channelId: event.channelId,
      messageTs: event.messageTs,
      threadTs: event.threadTs,
      senderUserId: event.senderUserId,
      text: event.text,
      mention: { type: event.mention.type, id: event.mention.id },
    },
    requester,
    profiles,
  };
}

/** Sign the exact UTF-8 JSON representation of the projected context. */
export function createAuthorizationProof(
  context: AuthorizationContext,
  signingKey: string,
): AuthorizationProof {
  if (signingKey.length < 32 || signingKey.trim() !== signingKey)
    return failPolicy();
  const payload = Buffer.from(JSON.stringify(context), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", signingKey)
    .update(payload, "utf8")
    .digest("hex");
  return { algorithm: "hmac-sha256", payload, signature };
}
