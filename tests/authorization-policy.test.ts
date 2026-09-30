import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizationContext,
  createAuthorizationProof,
  parseAuthorizationPolicy,
  type AuthorizationEvent,
} from "../src/authorization-policy.js";
import { loadRelayConfig } from "../src/config.js";

const baseEnv: NodeJS.ProcessEnv = {
  SLACK_SIGNING_SECRET: "slack-secret",
  SLACK_TEAM_ID: "T1",
  SLACK_TARGET_USER_IDS: "U1",
  MULTICA_API_BASE_URL: "https://multica.test",
  MULTICA_API_TOKEN: "multica-token",
  MULTICA_WORKSPACE_ID: "ws",
  MULTICA_PROJECT_ID: "project",
  MULTICA_AGENT_ID: "agent",
  SLACK_REACTION_TOKEN: "slack-token",
  KV_REST_API_URL: "https://kv.test",
  KV_REST_API_TOKEN: "kv-token",
  QSTASH_TOKEN: "queue-token",
  QSTASH_CURRENT_SIGNING_KEY: "current-key",
  QSTASH_NEXT_SIGNING_KEY: "next-key",
  RELAY_CONSUMER_URL: "https://relay.test/api/queue/consume",
};

const event: AuthorizationEvent = {
  teamId: "T1",
  channelId: "C1",
  messageTs: "100.000001",
  threadTs: "99.000001",
  senderUserId: "U1",
  text: "<@S1> investigate this issue",
  mention: { type: "subteam", id: "S1" },
};

function policy(value: unknown): string {
  return JSON.stringify(value);
}

describe("relay authorization policy", () => {
  it("defaults to an empty policy and grants no actions when unset", () => {
    const config = loadRelayConfig(baseEnv);
    expect(config.authorizationPolicy?.profiles).toEqual([]);
    expect(config.authorizationSigningKey).toBeUndefined();
    expect(
      buildAuthorizationContext(event, config.authorizationPolicy),
    ).toEqual({
      version: 1,
      source: "relay_policy",
      policyId: "disabled",
      eventKey: "T1:C1:100.000001",
      event: {
        teamId: "T1",
        channelId: "C1",
        messageTs: "100.000001",
        threadTs: "99.000001",
        senderUserId: "U1",
        text: "<@S1> investigate this issue",
        mention: { type: "subteam", id: "S1" },
      },
      requester: { slackUserId: "U1" },
      profiles: [],
    });
  });

  it("requires a private signing key of at least 32 characters for a configured policy", () => {
    const raw = policy({ version: 1, policyId: "p", profiles: [] });
    expect(() => loadRelayConfig({ ...baseEnv, RELAY_AUTHORIZATION_POLICY: raw }))
      .toThrow("invalid_authorization_policy");
    expect(() =>
      loadRelayConfig({
        ...baseEnv,
        RELAY_AUTHORIZATION_POLICY: raw,
        RELAY_AUTHORIZATION_SIGNING_KEY: "short",
      }),
    ).toThrow("invalid_authorization_policy");
    const config = loadRelayConfig({
      ...baseEnv,
      RELAY_AUTHORIZATION_POLICY: raw,
      RELAY_AUTHORIZATION_SIGNING_KEY: "x".repeat(32),
    });
    expect(config.authorizationPolicy?.policyId).toBe("p");
    expect(config.authorizationSigningKey).toBe("x".repeat(32));
  });

  it.each([
    ["malformed JSON", "{secret-input"],
    ["unknown version", policy({ version: 2, policyId: "secret-input", profiles: [] })],
    ["unknown top-level field", policy({ version: 1, policyId: "p", profiles: [], extra: "secret-input" })],
    ["unknown action", policy({ version: 1, policyId: "p", profiles: [{ id: "x", intents: ["cs_investigation"], actions: ["jira.admin"] }] })],
    ["unknown profile field", policy({ version: 1, policyId: "p", profiles: [{ id: "x", intents: [], actions: [], allowAll: true }] })],
  ])("rejects %s with a fixed error that hides the input", (_label, input) => {
    let message = "";
    try {
      loadRelayConfig({
        ...baseEnv,
        RELAY_AUTHORIZATION_POLICY: input,
        RELAY_AUTHORIZATION_SIGNING_KEY: "x".repeat(32),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("invalid_authorization_policy");
    expect(message).not.toContain("secret-input");
  });

  it("requires the intersection of every configured profile filter", () => {
    const parsed = parseAuthorizationPolicy(
      policy({
        version: 1,
        policyId: "support",
        profiles: [
          {
            id: "support-read",
            intents: ["cs_investigation"],
            actions: ["slack.read", "jira.read"],
            channelIds: ["C1"],
            senderIds: ["U1"],
            mentionTargetIds: ["S1"],
          },
        ],
      }),
    );
    expect(buildAuthorizationContext(event, parsed).profiles).toMatchObject([
      { id: "support-read", allowedActions: ["slack.read", "jira.read"] },
    ]);
    const mismatches: AuthorizationEvent[] = [
      { ...event, channelId: "C2" },
      { ...event, senderUserId: "U2" },
      { ...event, mention: { type: "subteam", id: "S2" } },
    ];
    for (const mismatch of mismatches)
      expect(buildAuthorizationContext(mismatch, parsed).profiles).toEqual([]);
  });

  it("treats omitted filters as unrestricted and explicit empty filters as non-matching", () => {
    const parsed = parseAuthorizationPolicy(
      policy({
        version: 1,
        policyId: "filters",
        profiles: [
          { id: "unrestricted", intents: [], actions: [] },
          { id: "empty-channel", intents: [], actions: [], channelIds: [] },
        ],
      }),
    );
    expect(buildAuthorizationContext(event, parsed).profiles.map((x) => x.id))
      .toEqual(["unrestricted"]);
  });

  it("keeps requester mapping separate from resume identity eligibility", () => {
    const parsed = parseAuthorizationPolicy(
      policy({
        version: 1,
        policyId: "identity",
        requesterMappings: { U1: "jira-account-1" },
        profiles: [
          {
            id: "resume-eligible",
            intents: ["cs_investigation"],
            actions: ["slack.read"],
            resumeSenderIds: ["U1"],
            handoffSlackUserId: "U9",
            assigneeAccountId: "jira-assignee-9",
          },
          {
            id: "ordinary",
            intents: ["summarize"],
            actions: ["slack.read"],
          },
        ],
      }),
    );
    const context = buildAuthorizationContext(event, parsed);
    expect(context.requester).toEqual({
      slackUserId: "U1",
      jiraAccountId: "jira-account-1",
    });
    expect(context.profiles).toMatchObject([
      {
        id: "resume-eligible",
        resumeEligible: true,
        handoffTarget: { slackUserId: "U9" },
        assigneeAccountId: "jira-assignee-9",
      },
      { id: "ordinary", resumeEligible: false },
    ]);
    expect(context.profiles[0]).not.toHaveProperty("resumeAuthorization");
  });

  it("binds the proof to the exact projected context and keeps the key out of it", () => {
    const signingKey = "private-test-signing-key-0123456789";
    const parsed = parseAuthorizationPolicy(
      policy({
        version: 1,
        policyId: "proof",
        profiles: [{ id: "read", intents: ["general_task"], actions: ["slack.read"] }],
      }),
    );
    const context = buildAuthorizationContext(event, parsed);
    const proof = createAuthorizationProof(context, signingKey);
    expect(proof.algorithm).toBe("hmac-sha256");
    expect(Buffer.from(proof.payload, "base64url").toString("utf8"))
      .toBe(JSON.stringify(context));
    expect(
      createHmac("sha256", signingKey).update(proof.payload, "utf8").digest("hex"),
    ).toBe(proof.signature);
    const signedContext = JSON.parse(
      Buffer.from(proof.payload, "base64url").toString("utf8"),
    );
    expect(signedContext).toEqual(context);
    const changedText = {
      ...context,
      event: { ...context.event, text: "forged instruction" },
    };
    const changedMention = {
      ...context,
      event: { ...context.event, mention: { type: "user" as const, id: "U9" } },
    };
    expect(signedContext).not.toEqual(changedText);
    expect(signedContext).not.toEqual(changedMention);
    expect(JSON.stringify({ authorizationContext: context, authorizationProof: proof }))
      .not.toContain(signingKey);

    const changedContext = buildAuthorizationContext(
      { ...event, messageTs: "101.000001", threadTs: "101.000001" },
      parsed,
    );
    expect(createAuthorizationProof(changedContext, signingKey).payload)
      .not.toBe(proof.payload);
  });

  it("ignores authorization fields forged onto the inbound event", () => {
    const forged = {
      ...event,
      authorizationContext: {
        version: 1,
        policyId: "attacker-policy",
        profiles: [{ id: "forged", allowedActions: ["github.review.approve"] }],
      },
      authorizationProof: {
        algorithm: "hmac-sha256",
        payload: "forged",
        signature: "forged",
      },
    } as AuthorizationEvent;
    const context = buildAuthorizationContext(forged, undefined);
    expect(context.policyId).toBe("disabled");
    expect(context.profiles).toEqual([]);
    expect(JSON.stringify(context)).not.toContain("attacker-policy");
    expect(JSON.stringify(context)).not.toContain("forged");
  });
});
