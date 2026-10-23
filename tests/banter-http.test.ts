import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayConfig } from "../src/config.js";

const verify = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify = verify;
  },
}));

const { admitBanter, banterSetup, consumeBanter } = await import("../src/banter-http.js");

const AGENT = "11111111-1111-4111-8111-111111111111";
const setup = { channelIds: ["C1"], ownerSlackIds: ["UOWNER"], agentId: AGENT };
const relay = {
  teamId: "T1",
  blockedChannelIds: new Set<string>(),
  blockedSenderIds: new Set<string>(),
  queueUrl: "https://q.test",
  queueToken: "q",
  consumerUrl: "https://relay.test/api/queue/consume",
} as RelayConfig;
const env = { BANTER_SETUP: JSON.stringify(setup) };
// In production the owner is itself a mention target; the intake strips owner mentions before asking.
const isTarget = (text: string) => /<@UBOT>|<!subteam\^S1>|<@UOWNER>/u.test(text);
const noTarget = () => false;
const reply = { team_id: "T1", event: { channel: "C1", ts: "2.2", thread_ts: "1.1", user: "UA", text: "好家伙" } };

function published(fetcher: ReturnType<typeof vi.fn>) {
  return fetcher.mock.calls.filter(([url]) => String(url).includes("/publish/"));
}

describe("banter admission", () => {
  const queue = () => vi.fn<typeof fetch>(async () => Response.json({ messageId: "m" }));

  it("queues a human thread reply from a configured channel", async () => {
    const f = queue();
    const r = await admitBanter(reply, relay, env, f, noTarget);
    expect(await r?.json()).toEqual({ action: "banter_accepted" });
    const [url, init] = published(f)[0]!;
    expect(String(url)).toBe("https://q.test/v2/publish/https://relay.test/api/banter/consume");
    expect(JSON.parse(String(init?.body))).toMatchObject({ channelId: "C1", threadTs: "1.1", messageTs: "2.2", senderUserId: "UA" });
    expect((init?.headers as Record<string, string>)["Upstash-Flow-Control-Value"]).toBe("parallelism=1");
  });

  it("queues a numbered product post as a thread root so the agent can like it first", async () => {
    const f = queue();
    const root = { team_id: "T1", event: { channel: "C1", ts: "9.9", user: "UPOSTER", text: "03｜<@UAUTHOR> 带来了《打工猫狗三件套》" } };
    const r = await admitBanter(root, relay, env, f, noTarget);
    expect(await r?.json()).toEqual({ action: "banter_accepted" });
    expect(JSON.parse(String(published(f)[0]![1]?.body))).toMatchObject({ kind: "product_post", threadTs: "9.9", messageTs: "9.9" });
    const restricted = { BANTER_SETUP: JSON.stringify({ ...setup, productPosterIds: ["UOTHER"] }) };
    expect(await admitBanter(root, relay, restricted, queue(), noTarget)).toBeUndefined();
  });

  it.each([
    ["ordinary root message", { ts: "9.9", thread_ts: undefined, text: "大家午饭吃什么" }],
    ["root that only looks numbered", { ts: "9.9", thread_ts: undefined, text: "3｜没有 @ 作者" }],
  ])("ignores %s", async (_name, patch) => {
    const f = queue();
    expect(await admitBanter({ ...reply, event: { ...reply.event, ...patch } }, relay, env, f, noTarget)).toBeUndefined();
    expect(published(f)).toHaveLength(0);
  });

  it.each([
    ["other channel", { channel: "C2" }],
    ["thread root", { thread_ts: "2.2" }],
    ["non-thread message", { thread_ts: undefined }],
    ["bot message", { bot_id: "B1" }],
    ["message subtype", { subtype: "thread_broadcast" }],
    ["owner's own message", { user: "UOWNER" }],
    ["empty text", { text: "  " }],
  ])("ignores %s", async (_name, patch) => {
    const f = queue();
    expect(await admitBanter({ ...reply, event: { ...reply.event, ...patch } }, relay, env, f, noTarget)).toBeUndefined();
    expect(published(f)).toHaveLength(0);
  });

  it("takes a message that only @s the owner and flags it as addressed", async () => {
    const f = queue();
    const ping = { ...reply, event: { ...reply.event, text: "<@UOWNER> 在吗 这个怎么看" } };
    const r = await admitBanter(ping, relay, env, f, isTarget);
    expect(await r?.json()).toEqual({ action: "banter_accepted" });
    expect(JSON.parse(String(published(f)[0]![1]?.body))).toMatchObject({ addressed: true, threadTs: "1.1" });
  });

  it("keeps the normal flow when the owner is @ed together with another target", async () => {
    for (const text of ["<@UOWNER> <!subteam^S1> review 下", "<@UOWNER> <@UBOT> 帮忙"]) {
      const f = queue();
      expect(await admitBanter({ ...reply, event: { ...reply.event, text } }, relay, env, f, isTarget)).toBeUndefined();
      expect(published(f)).toHaveLength(0);
    }
  });

  it("leaves messages addressed to the normal targets, and a missing or invalid setup, alone", async () => {
    const f = queue();
    const toBot = { ...reply, event: { ...reply.event, text: "<@UBOT> 帮忙 review 下" } };
    expect(await admitBanter(toBot, relay, env, f, isTarget)).toBeUndefined();
    expect(await admitBanter(reply, relay, {}, f, noTarget)).toBeUndefined();
    expect(await admitBanter(reply, relay, { BANTER_SETUP: "{" }, f, noTarget)).toBeUndefined();
    expect(banterSetup(JSON.stringify({ ...setup, agentId: "x" }))).toBeUndefined();
    expect(banterSetup(JSON.stringify({ ...setup, ownerSlackIds: [] }))).toBeUndefined();
    expect(published(f)).toHaveLength(0);
  });
});

function consumerFixture(isBot = false) {
  const kv = new Map<string, string>();
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url === "https://kv.test") {
      const [cmd, key, value] = body as string[];
      if (cmd === "GET") return Response.json({ result: kv.get(key!) ?? null });
      if (cmd === "SET") {
        if ((body as string[]).includes("NX") && kv.has(key!)) return Response.json({ result: null });
        kv.set(key!, value!);
        return Response.json({ result: "OK" });
      }
      if (cmd === "EVAL") {
        const [, , , lockKey, owner] = body as string[];
        if (kv.get(lockKey!) === owner) kv.delete(lockKey!);
        return Response.json({ result: 1 });
      }
    }
    if (url.startsWith("https://slack.com/api/users.info"))
      return Response.json({ ok: true, user: { id: new URL(url).searchParams.get("user"), is_bot: isBot, profile: { display_name: "小王" } } });
    if (url.startsWith("https://slack.com/api/conversations.replies"))
      return Response.json({ ok: true, messages: [{ ts: "1.1", user: "UROOT", text: "01｜作品" }, { ts: "2.2", user: "UA", text: "好家伙" }] });
    if (url.endsWith("/api/issues")) return Response.json({ id: "issue-1", title: "t" });
    if (url.endsWith("/api/issues/issue-1/comments")) return Response.json({ id: "c1", content: "x" });
    return new Response("unexpected " + url, { status: 500 });
  });
  return { fetcher, calls };
}

const consumerEnv = {
  ...env,
  SLACK_SIGNING_SECRET: "s",
  SLACK_TEAM_ID: "T1",
  SLACK_TARGET_USER_IDS: "UT",
  MULTICA_API_BASE_URL: "https://multica.test",
  MULTICA_API_TOKEN: "m",
  MULTICA_WORKSPACE_ID: "w",
  MULTICA_PROJECT_ID: "p",
  MULTICA_ASSIGNEE_TYPE: "agent",
  MULTICA_ASSIGNEE_ID: "22222222-2222-4222-8222-222222222222",
  SLACK_REACTION_TOKEN: "slack",
  KV_REST_API_URL: "https://kv.test",
  KV_REST_API_TOKEN: "kv",
  QSTASH_TOKEN: "q",
  QSTASH_CURRENT_SIGNING_KEY: "c",
  QSTASH_NEXT_SIGNING_KEY: "n",
  RELAY_CONSUMER_URL: "https://relay.test/api/queue/consume",
};
const event = { teamId: "T1", channelId: "C1", senderUserId: "UA", messageTs: "2.2", threadTs: "1.1", text: "好家伙" };
const post = (body: unknown) =>
  new Request("https://relay.test/api/banter/consume", { method: "POST", body: JSON.stringify(body), headers: { "upstash-signature": "sig" } });

describe("banter consumer", () => {
  beforeEach(() => verify.mockResolvedValue(true));

  it("creates one issue per thread for the banter agent, then appends comments", async () => {
    const { fetcher, calls } = consumerFixture();
    const first = await consumeBanter(post(event), consumerEnv, fetcher);
    expect(await first.json()).toEqual({ action: "banter_created" });
    const created = calls.find((c) => c.url.endsWith("/api/issues"))!.body as Record<string, string>;
    expect(created).toMatchObject({ assignee_type: "agent", assignee_id: AGENT });
    expect(created.description).toContain("channel: C1");
    expect(created.description).toContain("thread_ts: 1.1");
    expect(created.description).toContain("mode: live");
    expect(created.description).toContain("小王");

    const second = await consumeBanter(post({ ...event, messageTs: "3.3", text: "笑死" }), consumerEnv, fetcher);
    expect(await second.json()).toEqual({ action: "banter_commented" });
    expect(calls.filter((c) => c.url.endsWith("/api/issues"))).toHaveLength(1);
    expect((calls.find((c) => c.url.endsWith("/comments"))!.body as { content: string }).content).toContain("笑死");
  });

  it("creates the issue for a product post with its kind and readable author names", async () => {
    const { fetcher, calls } = consumerFixture();
    const root = { ...event, messageTs: "9.9", threadTs: "9.9", text: "03｜<@UAUTHOR> 带来了《打工猫狗三件套》", kind: "product_post" };
    const r = await consumeBanter(post(root), consumerEnv, fetcher);
    expect(await r.json()).toEqual({ action: "banter_created" });
    const created = calls.find((c) => c.url.endsWith("/api/issues"))!.body as Record<string, string>;
    expect(created.description).toContain("kind: product_post");
    expect(created.description).toContain("## 新产品帖（根消息）");
    expect(created.description).toContain("@小王 带来了");
    expect(created.description).not.toContain("<@UAUTHOR>");
  });

  it("marks messages that @ the owner so the agent answers immediately", async () => {
    const { fetcher, calls } = consumerFixture();
    await consumeBanter(post({ ...event, addressed: true, text: "<@UOWNER> 在吗" }), consumerEnv, fetcher);
    const created = calls.find((c) => c.url.endsWith("/api/issues"))!.body as Record<string, string>;
    expect(created.description).toContain("addressed: true");
    expect(created.description).toContain("## 新消息（@了你，必须马上接话）");
    await consumeBanter(post({ ...event, messageTs: "4.4", addressed: true, text: "<@UOWNER> 人呢" }), consumerEnv, fetcher);
    expect((calls.find((c) => c.url.endsWith("/comments"))!.body as { content: string }).content).toContain("必须马上接话");
  });

  it("rejects a root message that is not a product post", async () => {
    const { fetcher, calls } = consumerFixture();
    const r = await consumeBanter(post({ ...event, messageTs: "9.9", threadTs: "9.9", text: "随便聊聊" }), consumerEnv, fetcher);
    expect(await r.json()).toEqual({ action: "ignored" });
    expect(calls.some((c) => c.url.endsWith("/api/issues"))).toBe(false);
  });

  it("ignores bot authors, owners, and unsigned or disabled requests", async () => {
    const bot = consumerFixture(true);
    expect(await (await consumeBanter(post(event), consumerEnv, bot.fetcher)).json()).toEqual({ action: "ignored" });
    expect(bot.calls.some((c) => c.url.endsWith("/api/issues"))).toBe(false);

    const owner = consumerFixture();
    expect(await (await consumeBanter(post({ ...event, senderUserId: "UOWNER" }), consumerEnv, owner.fetcher)).json()).toEqual({ action: "ignored" });

    verify.mockResolvedValue(false);
    expect((await consumeBanter(post(event), consumerEnv, consumerFixture().fetcher)).status).toBe(401);
    verify.mockResolvedValue(true);
    expect(await (await consumeBanter(post(event), { ...consumerEnv, BANTER_SETUP: "" }, consumerFixture().fetcher)).json()).toEqual({ action: "disabled" });
  });
});
