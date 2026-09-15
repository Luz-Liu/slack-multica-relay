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
const botPolicyEnv = {
  ...env,
  SLACK_BOT_USER_IDS: "UBOT",
  SLACK_BOT_ALLOWED_SENDER_IDS: "U2",
};
function signedRequest(bodyValue: unknown): Request {
  const body = JSON.stringify(bodyValue);
  const ts = String(Math.floor(Date.now() / 1000));
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
function request(event: unknown, teamId = "T1"): Request {
  return signedRequest({ type: "event_callback", team_id: teamId, event });
}
function queueCalls(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
  return fetcher.mock.calls.filter(([input]) =>
    String(input).includes("/v2/publish/"),
  );
}
function admissionFixture(options: {
  reaction?: "ok" | "fail" | "timeout";
  queueFailures?: number;
} = {}) {
  const values = new Map<string, string>();
  const calls: string[] = [];
  let queueFailures = options.queueFailures ?? 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    if (url === env.KV_REST_API_URL) {
      calls.push("kv");
      const parts = JSON.parse(String(init.body)) as string[];
      const command = parts[0];
      if (command === "SET" && parts[3] === "NX") {
        if (values.has(parts[1]!)) return Response.json({ result: null });
        values.set(parts[1]!, parts[2]!);
        return Response.json({ result: "OK" });
      }
      if (command === "SET") {
        values.set(parts[1]!, parts[2]!);
        return Response.json({ result: "OK" });
      }
      if (command === "EVAL") {
        if (values.get(parts[3]!) === parts[4]) values.delete(parts[3]!);
        return Response.json({ result: 1 });
      }
      if (command === "GET") return Response.json({ result: values.get(parts[1]!) ?? null });
      throw new Error("unexpected_kv_command");
    }
    if (url === "https://slack.com/api/reactions.add") {
      calls.push("reaction");
      if (options.reaction === "fail")
        return Response.json({ ok: false, error: "ratelimited" });
      if (options.reaction === "timeout") {
        return await new Promise<Response>((resolve, reject) => {
          const signal = init.signal;
          const abort = () => reject(signal?.reason ?? new DOMException("timeout", "TimeoutError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return Response.json({ ok: true });
    }
    if (url.includes("/v2/publish/")) {
      calls.push("queue");
      if (queueFailures > 0) {
        queueFailures--;
        throw new Error("queue unavailable");
      }
      return Response.json({ messageId: "msg" });
    }
    throw new Error("unexpected_endpoint");
  });
  return { fetcher, calls, values };
}
const event = {
  type: "message",
  channel: "C1",
  user: "U2",
  ts: "100.000001",
  text: "<@U1> test",
};
const appMentionEvent = {
  ...event,
  type: "app_mention",
};
afterEach(() => vi.restoreAllMocks());
describe("durable admission", () => {
  it("only publishes to queue before acknowledging", async () => {
    const { fetcher } = admissionFixture();
    const response = await acceptSlack(request(event), env, fetcher);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      action: "accepted",
      queueMessageId: "msg",
    });
    expect(queueCalls(fetcher)).toHaveLength(1);
    expect(String(queueCalls(fetcher)[0]![0])).toContain(
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
  it("accepts a human app_mention event", async () => {
    const { fetcher } = admissionFixture();
    const response = await acceptSlack(request(appMentionEvent), env, fetcher);
    expect(response.status).toBe(200);
    expect(queueCalls(fetcher)).toHaveLength(1);
  });
  it("accepts an allowed sender mentioning a configured Bot", async () => {
    const { fetcher } = admissionFixture();
    const response = await acceptSlack(
      request({ ...event, text: "<@UBOT> please handle this" }),
      botPolicyEnv,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(queueCalls(fetcher)).toHaveLength(1);
  });
  it("can use a configured Bot as the only mention target", async () => {
    const { SLACK_TARGET_USER_IDS: _ignored, ...botOnlyEnv } = botPolicyEnv;
    const { fetcher } = admissionFixture();
    const response = await acceptSlack(
      request({ ...event, text: "<@UBOT> please handle this" }),
      botOnlyEnv,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(queueCalls(fetcher)).toHaveLength(1);
  });
  it.each(["message", "app_mention"])(
    "rejects a disallowed sender mentioning a configured Bot for %s",
    async (type) => {
      const fetcher = vi.fn<typeof fetch>();
      const response = await acceptSlack(
        request({
          ...event,
          type,
          user: "U3",
          text: "<@UBOT> please handle this",
        }),
        botPolicyEnv,
        fetcher,
      );
      expect(await response.json()).toEqual({
        action: "ignored",
        reason: "not_allowed",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("keeps owner mentions on the existing sender policy", async () => {
    const { fetcher } = admissionFixture();
    const response = await acceptSlack(
      request({ ...event, user: "U3" }),
      botPolicyEnv,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(queueCalls(fetcher)).toHaveLength(1);
  });
  it.each([
    ["message", "<@UBOT> then <@U1>"],
    ["app_mention", "<@UBOT> then <@U1>"],
    ["message", "<@U1> then <@UBOT>"],
    ["app_mention", "<@U1> then <@UBOT>"],
  ])(
    "rejects a disallowed sender when a Bot and owner are both mentioned (%s, %s)",
    async (type, text) => {
      const fetcher = vi.fn<typeof fetch>();
      const response = await acceptSlack(
        request({ ...event, type, user: "U3", text }),
        botPolicyEnv,
        fetcher,
      );
      expect(await response.json()).toEqual({
        action: "ignored",
        reason: "not_allowed",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("fails closed for Bot mentions when the Bot sender allowlist is absent", async () => {
    const { SLACK_BOT_ALLOWED_SENDER_IDS: _ignored, ...closedEnv } = botPolicyEnv;
    const fetcher = vi.fn<typeof fetch>();
    const response = await acceptSlack(
      request({ ...event, text: "<@UBOT> please handle this" }),
      closedEnv,
      fetcher,
    );
    expect(await response.json()).toEqual({
      action: "ignored",
      reason: "not_allowed",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("adds eyes during admission and skips message/app_mention replays", async () => {
    const fixture = admissionFixture();
    const first = await acceptSlack(request(event), env, fixture.fetcher);
    expect(first.status).toBe(200);
    expect(fixture.calls.indexOf("reaction")).toBeLessThan(
      fixture.calls.indexOf("queue"),
    );
    expect(fixture.calls.filter((call) => call === "reaction")).toHaveLength(1);

    await acceptSlack(request(appMentionEvent), env, fixture.fetcher);
    await acceptSlack(request(event), env, fixture.fetcher);
    expect(fixture.calls.filter((call) => call === "reaction")).toHaveLength(1);
    expect(queueCalls(fixture.fetcher)).toHaveLength(3);
  });
  it("does not react to a Slack URL verification challenge", async () => {
    const fixture = admissionFixture();
    const response = await acceptSlack(
      signedRequest({ type: "url_verification", challenge: "challenge" }),
      env,
      fixture.fetcher,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "challenge" });
    expect(fixture.calls).toEqual([]);
  });
  it("ignores an app_mention to an unknown target", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await acceptSlack(
      request({ ...appMentionEvent, text: "<@U999> test" }),
      env,
      fetcher,
    );
    expect(await response.json()).toEqual({
      action: "ignored",
      reason: "not_addressed",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { bot_id: "B1" },
    { app_id: "A1" },
  ])("ignores an automatic app_mention event %j", async (change) => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await acceptSlack(
      request({ ...appMentionEvent, ...change }),
      env,
      fetcher,
    );
    expect(await response.json()).toEqual({ action: "ignored" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses the same queue deduplication key for message and app_mention", async () => {
    const { fetcher } = admissionFixture();
    await acceptSlack(request(event), env, fetcher);
    await acceptSlack(request(appMentionEvent), env, fetcher);
    expect(queueCalls(fetcher)).toHaveLength(2);
    const queueRequests = queueCalls(fetcher);
    const firstHeaders = new Headers(queueRequests[0]![1]?.headers);
    const secondHeaders = new Headers(queueRequests[1]![1]?.headers);
    expect(firstHeaders.get("Upstash-Deduplication-Id")).toBe(
      secondHeaders.get("Upstash-Deduplication-Id"),
    );
  });
  it.each([
    ["channel", { channel: "C2" }, { SLACK_ALLOWED_CHANNEL_IDS: "C1" }],
    ["sender", { user: "U3" }, { SLACK_ALLOWED_SENDER_IDS: "U2" }],
  ])("applies %s policy to app_mention events", async (_policy, change, policy) => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await acceptSlack(
      request({ ...appMentionEvent, ...change }),
      { ...env, ...policy },
      fetcher,
    );
    expect(await response.json()).toEqual({
      action: "ignored",
      reason: "not_allowed",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("continues queue dispatch when the early reaction fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixture = admissionFixture({ reaction: "fail" });
    const response = await acceptSlack(request(event), env, fixture.fetcher);
    expect(response.status).toBe(200);
    expect(fixture.calls.filter((call) => call === "reaction")).toHaveLength(1);
    expect(queueCalls(fixture.fetcher)).toHaveLength(1);

    await acceptSlack(request(event), env, fixture.fetcher);
    expect(fixture.calls.filter((call) => call === "reaction")).toHaveLength(1);
  });
  it("continues queue dispatch when the early reaction times out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixture = admissionFixture({ reaction: "timeout" });
    const started = Date.now();
    const response = await acceptSlack(request(event), env, fixture.fetcher);
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(fixture.calls.filter((call) => call === "reaction")).toHaveLength(1);
    expect(queueCalls(fixture.fetcher)).toHaveLength(1);
  });
  it("returns a retryable response when queue dispatch fails without re-reacting", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixture = admissionFixture({ queueFailures: 1 });
    const first = await acceptSlack(request(event), env, fixture.fetcher);
    expect(first.status).toBe(503);
    const second = await acceptSlack(request(event), env, fixture.fetcher);
    expect(second.status).toBe(200);
    expect(fixture.calls.filter((call) => call === "reaction")).toHaveLength(1);
    expect(queueCalls(fixture.fetcher)).toHaveLength(2);
  });
  it("rejects another Slack team", async () => {
    const f = vi.fn<typeof fetch>();
    await acceptSlack(request(event, "T2"), env, f);
    expect(f).not.toHaveBeenCalled();
  });
  it("accepts all as the channel allowlist", async () => {
    const { fetcher: f } = admissionFixture();
    const response = await acceptSlack(
      request({ ...event, channel: "C2" }),
      { ...env, SLACK_ALLOWED_CHANNEL_IDS: "all" },
      f,
    );
    expect(response.status).toBe(200);
    expect(queueCalls(f)).toHaveLength(1);
  });
  it("defaults the channel allowlist to all when omitted", async () => {
    const { fetcher: f } = admissionFixture();
    const { SLACK_ALLOWED_CHANNEL_IDS: _ignored, ...withoutChannelAllowlist } = env;
    const response = await acceptSlack(
      request({ ...event, channel: "C2" }),
      withoutChannelAllowlist,
      f,
    );
    expect(response.status).toBe(200);
    expect(queueCalls(f)).toHaveLength(1);
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
  it("rechecks Bot sender policy from queued text after configuration changes", async () => {
    const f = vi.fn<typeof fetch>();
    const queued = {
      teamId: "T1",
      channelId: "C1",
      senderUserId: "U3",
      messageTs: "1.000001",
      threadTs: "1.000001",
      text: "<@UBOT> test",
      mention: { type: "user", id: "UBOT" },
    };
    const response = await consumeQueue(
      new Request(botPolicyEnv.RELAY_CONSUMER_URL, {
        method: "POST",
        body: JSON.stringify(queued),
      }),
      botPolicyEnv,
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
    let reactionPosts = 0;
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
      if (url === "https://slack.com/api/reactions.add") {
        reactionPosts++;
        return Response.json({ ok: true });
      }
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
    expect(reactionPosts).toBe(0);
  });
});

describe("Team configuration admission", () => {
  it("accepts a Team without the legacy agent variable", async () => {
    const { MULTICA_AGENT_ID: _legacy, ...base } = env;
    const { fetcher: f } = admissionFixture();
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
