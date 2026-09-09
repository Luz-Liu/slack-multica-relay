import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptSlack, consumeQueue } from "../src/http.js";
vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify = vi.fn().mockResolvedValue(true);
  },
}));
const env = {
  SLACK_SIGNING_SECRET: "test",
  SLACK_TEAM_ID: "T1",
  SLACK_TARGET_USER_IDS: "U1",
  SLACK_ALLOWED_CHANNEL_IDS: "C1",
  MULTICA_API_BASE_URL: "https://multica.test",
  MULTICA_API_TOKEN: "test",
  MULTICA_WORKSPACE_ID: "ws",
  MULTICA_PROJECT_ID: "project",
  MULTICA_AGENT_ID: "agent",
  SLACK_REACTION_TOKEN: "test",
  SLACK_REACTION_NAME: "eyes",
  KV_REST_API_URL: "https://kv.test",
  KV_REST_API_TOKEN: "test",
  QSTASH_TOKEN: "test",
  QSTASH_CURRENT_SIGNING_KEY: "test",
  QSTASH_NEXT_SIGNING_KEY: "test",
  RELAY_CONSUMER_URL: "https://relay.test/api/queue/consume",
};
function request(event: unknown, teamId = "T1"): Request {
  const body = JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      event,
    }),
    ts = String(Math.floor(Date.now() / 1000));
  return new Request("https://relay.test/api/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": ts,
      "x-slack-signature":
        "v0=" +
        createHmac("sha256", "test")
          .update("v0:" + ts + ":" + body)
          .digest("hex"),
    },
    body,
  });
}
const event = {
  type: "message",
  channel: "C1",
  user: "U2",
  ts: "100.000001",
  text: "<@U1> test",
};
afterEach(() => vi.restoreAllMocks());
describe("durable admission", () => {
  it("only publishes to queue before acknowledging", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ messageId: "msg" }));
    const response = await acceptSlack(request(event), env, fetcher);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      action: "accepted",
      queueMessageId: "msg",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain(
      "/v2/publish/https://relay.test/api/queue/consume",
    );
  });
  it.each([
    { channel: "C2" },
    { user: undefined },
    { text: "ordinary", thread_ts: "1.000001" },
    { bot_id: "B1" },
    { subtype: "message_changed" },
  ])("no queue side effects for %j", async (change) => {
    const fetcher = vi.fn<typeof fetch>();
    await acceptSlack(request({ ...event, ...change }), env, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects another Slack team", async () => {
    const f = vi.fn<typeof fetch>();
    await acceptSlack(request(event, "T2"), env, f);
    expect(f).not.toHaveBeenCalled();
  });
  it("accepts all as the channel allowlist", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ messageId: "msg" }));
    const response = await acceptSlack(
      request({ ...event, channel: "C2" }),
      { ...env, SLACK_ALLOWED_CHANNEL_IDS: "all" },
      f,
    );
    expect(response.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("defaults the channel allowlist to all when omitted", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ messageId: "msg" }));
    const { SLACK_ALLOWED_CHANNEL_IDS: _ignored, ...withoutChannelAllowlist } = env;
    const response = await acceptSlack(
      request({ ...event, channel: "C2" }),
      withoutChannelAllowlist,
      f,
    );
    expect(response.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("blocks a channel even when the allowlist is all", async () => {
    const f = vi.fn<typeof fetch>();
    const response = await acceptSlack(
      request({ ...event, channel: "C2" }),
      { ...env, SLACK_ALLOWED_CHANNEL_IDS: "all", SLACK_BLOCKED_CHANNEL_IDS: "C2" },
      f,
    );
    expect(await response.json()).toEqual({ action: "ignored", reason: "not_allowed" });
    expect(f).not.toHaveBeenCalled();
  });
  it("applies sender policy", async () => {
    const f = vi.fn<typeof fetch>();
    await acceptSlack(
      request(event),
      { ...env, SLACK_ALLOWED_SENDER_IDS: "U3" },
      f,
    );
    expect(f).not.toHaveBeenCalled();
  });
  it("blocks a sender even when the sender allowlist is all", async () => {
    const f = vi.fn<typeof fetch>();
    const response = await acceptSlack(
      request(event),
      { ...env, SLACK_ALLOWED_SENDER_IDS: "all", SLACK_BLOCKED_SENDER_IDS: "U2" },
      f,
    );
    expect(await response.json()).toEqual({ action: "ignored", reason: "not_allowed" });
    expect(f).not.toHaveBeenCalled();
  });
  it("keeps Slack retry ownership when queue publish fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret body"));
    const response = await acceptSlack(request(event), env, f);
    expect(response.status).toBe(503);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "secret body",
    );
  });
  it("rejects invalid signature before network", async () => {
    const f = vi.fn<typeof fetch>();
    expect(
      (
        await acceptSlack(
          new Request("https://relay.test", { method: "POST", body: "{}" }),
          env,
          f,
        )
      ).status,
    ).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });
  it("rechecks channel policy for queued messages", async () => {
    const f = vi.fn<typeof fetch>();
    const queued = {
      teamId: "T1",
      channelId: "C2",
      senderUserId: "U2",
      messageTs: "1.000001",
      threadTs: "1.000001",
      text: "<@U1> test",
      mention: { type: "user", id: "U1" },
    };
    const response = await consumeQueue(
      new Request(env.RELAY_CONSUMER_URL, {
        method: "POST",
        body: JSON.stringify(queued),
      }),
      env,
      f,
    );
    expect(await response.json()).toEqual({
      action: "ignored",
      reason: "policy_changed",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("fetches configuration in the consumer and delivers a separate trusted reply context", async () => {
    const kv = new Map<string, string>();
    const agentUrls: string[] = [];
    let description = "";
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === env.KV_REST_API_URL) {
        const [command, key, value, mode] = JSON.parse(String(init?.body)) as string[];
        if (command === "GET") return Response.json({ result: kv.get(key!) ?? null });
        if (command === "SET") {
          if (mode === "NX" && kv.has(key!)) return Response.json({ result: null });
          kv.set(key!, value!);
          return Response.json({ result: "OK" });
        }
        if (command === "EVAL") return Response.json({ result: 1 });
      }
      if (url === "https://multica.test/api/agents/agent") {
        agentUrls.push(url);
        return Response.json({ id: "agent", workspace_id: "ws", model: "gpt-6-astra", service_tier: "default" });
      }
      if (url.includes("/api/issues?")) return Response.json({ issues: [] });
      if (url.endsWith("/api/issues")) {
        const body = JSON.parse(String(init?.body));
        description = body.description;
        return Response.json({ id: "issue", title: body.title });
      }
      if (url === "https://slack.com/api/reactions.add") return Response.json({ ok: true });
      throw new Error("unexpected endpoint");
    };
    const response = await consumeQueue(new Request(env.RELAY_CONSUMER_URL, {
      method: "POST",
      body: JSON.stringify({
        teamId: "T1", channelId: "C1", senderUserId: "U2", messageTs: "100.000001", threadTs: "100.000001",
        text: "<@U1> test", mention: { type: "user", id: "U1" },
        replyContext: { model: "spoofed", serviceTier: "priority" },
      }),
    }), env, fetcher);
    expect(response.status).toBe(200);
    expect(agentUrls).toHaveLength(1);
    const delivered = JSON.parse(description.match(/```json\n([\s\S]*?)\n```/)![1]!);
    expect(delivered.replyContext).toMatchObject({ type: "slack_reply_context", source: "agent_config", status: "available", model: "gpt-6-astra", serviceTier: "default" });
    expect(delivered.eventPayload).not.toHaveProperty("replyContext");
    expect(description).not.toContain("spoofed");
  });
});

describe("Team configuration admission", () => {
  it("accepts a Team without the legacy agent variable", async () => {
    const { MULTICA_AGENT_ID: _legacy, ...base } = env;
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ messageId: "m" }));
    expect((await acceptSlack(request(event), { ...base, MULTICA_ASSIGNEE_TYPE: "squad", MULTICA_ASSIGNEE_ID: "team" }, f)).status).toBe(200);
  });
  it.each([
    { MULTICA_ASSIGNEE_TYPE: "unknown", MULTICA_ASSIGNEE_ID: "team" },
    { MULTICA_ASSIGNEE_TYPE: "squad" },
    { MULTICA_ASSIGNEE_TYPE: "squad", MULTICA_ASSIGNEE_ID: "team", MULTICA_LEGACY_AGENT_ID: "agent", MULTICA_THREAD_SCOPE_ID: "wrong" },
  ])("rejects invalid Team configuration %j", async (extra) => {
    const f = vi.fn<typeof fetch>();
    expect((await acceptSlack(request(event), { ...env, ...extra }, f)).status).toBe(500);
    expect(f).not.toHaveBeenCalled();
  });
});
