import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptSlack } from "../src/http.js";
import {
  consumeDeployClose,
  deployCloseSetup,
  matchDeployConfirm,
  rootMentionsOwner,
} from "../src/deploy-close.js";
import * as api from "../src/multica-api.js";
import { digest } from "../src/thread-router.js";
import { formatTaskDescription } from "../src/task-presentation.js";
vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify = vi.fn().mockResolvedValue(true);
  },
}));
const PROJECT = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const setup = {
  channelIds: ["C1"],
  signalBotIds: ["B1"],
  signalUserIds: ["UGHA"],
  successTexts: ["Deployed to production successful."],
  failedTexts: ["Deploy failed."],
  ownerSlackUserId: "ULUZ",
  rootPrefilterMention: true,
  projectId: PROJECT,
  assigneeType: "agent",
  assigneeId: AGENT,
};
const base = {
  SLACK_SIGNING_SECRET: "test",
  SLACK_TEAM_ID: "T1",
  SLACK_TARGET_USER_IDS: "ULUZ",
  SLACK_ALLOWED_CHANNEL_IDS: "all",
  MULTICA_API_BASE_URL: "https://multica.test",
  MULTICA_API_TOKEN: "test",
  MULTICA_WORKSPACE_ID: "ws",
  MULTICA_PROJECT_ID: "project",
  MULTICA_AGENT_ID: "agent",
  SLACK_REACTION_TOKEN: "test",
  KV_REST_API_URL: "https://kv.test",
  KV_REST_API_TOKEN: "test",
  QSTASH_TOKEN: "test",
  QSTASH_CURRENT_SIGNING_KEY: "test",
  QSTASH_NEXT_SIGNING_KEY: "test",
  RELAY_CONSUMER_URL: "https://relay.test/api/queue/consume",
};
const enabled = { ...base, DEPLOY_CLOSE_SETUP: JSON.stringify(setup) };
const signal = {
  type: "message",
  channel: "C1",
  user: "UGHA",
  bot_id: "B1",
  ts: "200.000002",
  thread_ts: "200.000001",
  text: "Deployed to production successful.",
};
const rootText =
  ":rocket: *Confirm Deploy: <https://github.com/o/Boarding_Desktop/actions/runs/1|Boarding_Desktop (#1672)> (production)*\n1. <https://moego.atlassian.net/browse/GRM-1|GRM-1> fix <@ULUZ|Luz>";
function signed(event: unknown): Request {
  const body = JSON.stringify({ type: "event_callback", team_id: "T1", event });
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request("https://relay.test/api/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": "v0=" + createHmac("sha256", "test").update("v0:" + ts + ":" + body).digest("hex"),
    },
    body,
  });
}
function fetcher(root: Record<string, unknown> = { ts: "200.000001", bot_id: "B1", text: rootText }) {
  const values = new Map<string, string>();
  return vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/v2/publish/")) return Response.json({ messageId: "m" });
    if (url.startsWith("https://slack.com/api/conversations.replies"))
      return Response.json({ ok: true, messages: [root] });
    if (url === "https://kv.test") {
      const parts = JSON.parse(String(init.body)) as string[];
      if (parts[0] === "SET" && parts[3] === "NX") {
        if (values.has(parts[1]!)) return Response.json({ result: null });
        values.set(parts[1]!, parts[2]!);
        return Response.json({ result: "OK" });
      }
      if (parts[0] === "SET") {
        values.set(parts[1]!, parts[2]!);
        return Response.json({ result: "OK" });
      }
      if (parts[0] === "GET") return Response.json({ result: values.get(parts[1]!) ?? null });
      if (parts[0] === "EVAL") {
        values.delete(parts[3]!);
        return Response.json({ result: 1 });
      }
    }
    throw new Error("unexpected_endpoint " + url);
  });
}
function consumeRequest(body: unknown): Request {
  return new Request("https://relay.test/api/deploy-close/consume", {
    method: "POST",
    headers: { "upstash-signature": "sig" },
    body: JSON.stringify(body),
  });
}
const queued = {
  teamId: "T1",
  channelId: "C1",
  messageTs: "200.000002",
  threadTs: "200.000001",
  senderUserId: "UGHA",
  botId: "B1",
  text: "Deployed to production successful.",
};
afterEach(() => vi.restoreAllMocks());

describe("deploy close admission", () => {
  it("keeps the original behavior when DEPLOY_CLOSE_SETUP is unset", async () => {
    const f = fetcher();
    const response = await acceptSlack(signed(signal), base, f);
    expect(await response.json()).toEqual({ action: "ignored", reason: "not_addressed" });
    expect(f).not.toHaveBeenCalled();
  });
  it("treats an invalid setup as disabled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fetcher();
    const response = await acceptSlack(signed(signal), { ...base, DEPLOY_CLOSE_SETUP: "{bad" }, f);
    expect(await response.json()).toEqual({ action: "ignored", reason: "not_addressed" });
    expect(f).not.toHaveBeenCalled();
  });
  it("queues the exact success reply to the deploy-close consumer without users.info or reactions", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const f = fetcher();
    const response = await acceptSlack(signed(signal), enabled, f);
    expect(await response.json()).toEqual({ action: "deploy_close_accepted", signal: "success" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toBe(
      "https://qstash.upstash.io/v2/publish/https://relay.test/api/deploy-close/consume",
    );
  });
  it("queues the exact failed reply", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await acceptSlack(signed({ ...signal, text: "Deploy failed." }), enabled, fetcher());
    expect(await response.json()).toEqual({ action: "deploy_close_accepted", signal: "failed" });
  });
  it.each([
    ["other bot", { bot_id: "B2" }],
    ["other bot user", { user: "UOTHER" }],
    ["human without bot_id", { bot_id: undefined }],
    ["other channel", { channel: "C2" }],
    ["root message", { thread_ts: undefined }],
    ["root itself", { thread_ts: "200.000002" }],
    ["extra character", { text: "Deployed to production successful.!" }],
    ["canary", { text: "Canary started on production, see <#C07TGEPDU2E>." }],
    ["message_changed", { subtype: "message_changed" }],
    ["bot_message subtype", { subtype: "bot_message" }],
  ])("falls back to the original path for %s", async (_name, change) => {
    const f = fetcher();
    const response = await acceptSlack(signed({ ...signal, ...change }), enabled, f);
    expect((await response.json()).action).not.toBe("deploy_close_accepted");
    expect(f.mock.calls.some(([u]) => String(u).includes("deploy-close"))).toBe(false);
  });
  it("honors the sender blocklist", async () => {
    const f = fetcher();
    const response = await acceptSlack(signed(signal), { ...enabled, SLACK_BLOCKED_SENDER_IDS: "UGHA" }, f);
    expect((await response.json()).action).not.toBe("deploy_close_accepted");
  });
  it("matches owner mentions with or without a display label", () => {
    expect(rootMentionsOwner("<@ULUZ|Luz Liu>", "ULUZ")).toBe(true);
    expect(rootMentionsOwner("<@ULUZ>", "ULUZ")).toBe(true);
    expect(rootMentionsOwner("<@ULUZX>", "ULUZ")).toBe(false);
  });
  it("rejects setup without required ids", () => {
    expect(() => deployCloseSetup(JSON.stringify({ ...setup, projectId: "x" }))).toThrow();
    expect(deployCloseSetup(undefined)).toBeUndefined();
  });
});

describe("deploy close consumer", () => {
  it("creates one Multica issue in the dedicated project for a Luz root", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(api, "findIssue").mockResolvedValue(undefined);
    vi.spyOn(api, "getSlackReplyContext").mockResolvedValue(undefined as never);
    const create = vi.spyOn(api, "createIssue").mockResolvedValue({ id: "i1" } as api.MulticaIssue);
    const response = await consumeDeployClose(consumeRequest(queued), enabled, fetcher());
    expect(await response.json()).toEqual({ action: "created", issueId: "i1", signal: "success" });
    const [config, title, description] = create.mock.calls[0]!;
    expect(config.multicaProjectId).toBe(PROJECT);
    expect(config.multicaAssigneeId).toBe(AGENT);
    expect(title).toMatch(/^Deploy close · Boarding_Desktop \(#1672\) · \[[0-9a-f]{16}\]$/);
    expect(description).toContain('"senderUserId": "UGHA"');
  });
  it("silently skips roots that do not mention the owner", async () => {
    const create = vi.spyOn(api, "createIssue");
    const response = await consumeDeployClose(
      consumeRequest(queued),
      enabled,
      fetcher({ ts: "200.000001", bot_id: "B1", text: rootText.replace("<@ULUZ|Luz>", "<@UOTHER>") }),
    );
    expect(await response.json()).toEqual({ action: "ignored", reason: "owner_not_mentioned" });
    expect(create).not.toHaveBeenCalled();
  });
  it.each([
    ["not production", { ts: "200.000001", bot_id: "B1", text: rootText.replace("(production)", "(staging)") }],
    ["human root", { ts: "200.000001", user: "ULUZ", text: rootText }],
    ["different ts", { ts: "199.000001", bot_id: "B1", text: rootText }],
    ["production only in a ticket title", { ts: "200.000001", bot_id: "B1", text: rootText.replace("> (production)*", "> (staging)*") + " fix (production) timeout" }],
  ])("ignores a root that is not a Confirm Deploy production root: %s", async (_n, root) => {
    const create = vi.spyOn(api, "createIssue");
    const response = await consumeDeployClose(consumeRequest(queued), enabled, fetcher(root));
    expect(await response.json()).toEqual({ action: "ignored", reason: "not_confirm_deploy_root" });
    expect(create).not.toHaveBeenCalled();
  });
  it("re-checks the payload against current setup", async () => {
    const response = await consumeDeployClose(consumeRequest({ ...queued, botId: "B2" }), enabled, fetcher());
    expect(await response.json()).toEqual({ action: "ignored", reason: "policy_changed" });
  });
  it("is disabled when the switch is removed", async () => {
    const response = await consumeDeployClose(consumeRequest(queued), base, fetcher());
    expect(await response.json()).toEqual({ action: "disabled" });
  });
});

const confirmEnv = { ...base, DEPLOY_CLOSE_SETUP: JSON.stringify({ ...setup, askBotUserId: "UBOT" }) };
const relay = { teamId: "T1", blockedChannelIds: new Set<string>(), blockedSenderIds: new Set<string>() };
const fullSetup = deployCloseSetup(confirmEnv.DEPLOY_CLOSE_SETUP)!;
const reaction = {
  type: "reaction_added",
  user: "ULUZ",
  reaction: "white_check_mark",
  item_user: "UBOT",
  item: { type: "message", channel: "C1", ts: "200.000003" },
  event_ts: "300.000001",
};
const askMessage = { ts: "200.000003", thread_ts: "200.000001", user: "UBOT", text: "关单？ [deploy-close:v1]" };
const confirmBody = { kind: "confirm", teamId: "T1", event: reaction };
const rootMessage = { ts: "200.000001", bot_id: "B1", text: rootText };

function confirmFetcher(ask: Record<string, unknown> = askMessage) {
  const inner = fetcher();
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://slack.com/api/conversations.replies")) {
      const ts = new URL(url).searchParams.get("ts");
      return Response.json({ ok: true, messages: [ts === "200.000003" ? ask : rootMessage] });
    }
    return inner(input, init);
  });
}
function mockExistingIssue() {
  const description = formatTaskDescription(
    { ...queued, mention: { type: "user", id: "ULUZ" } },
    "<!-- m -->",
  );
  vi.spyOn(api, "findIssue").mockResolvedValue({ id: "i1", description } as api.MulticaIssue);
  vi.spyOn(api, "validateMappedIssue").mockResolvedValue(undefined);
  vi.spyOn(api, "findComment").mockResolvedValue(undefined);
  vi.spyOn(api, "getSlackReplyContext").mockResolvedValue(undefined as never);
  return vi.spyOn(api, "createComment").mockResolvedValue({} as api.MulticaComment);
}

describe("deploy close confirm matching", () => {
  it("accepts the owner's confirm reaction on the ask bot's message", () => {
    expect(matchDeployConfirm("T1", reaction, relay, fullSetup)).toEqual({
      channelId: "C1",
      askTs: "200.000003",
      user: "ULUZ",
      reaction: "white_check_mark",
      eventTs: "300.000001",
    });
  });
  it.each([
    ["another user", { user: "UOTHER" }],
    ["another emoji", { reaction: "eyes" }],
    ["reaction_removed", { type: "reaction_removed" }],
    ["another channel", { item: { type: "message", channel: "C2", ts: "200.000003" } }],
    ["a file item", { item: { type: "file", channel: "C1", ts: "200.000003" } }],
    ["a message from another user", { item_user: "UOTHER" }],
    ["an invalid event_ts", { event_ts: "x" }],
  ])("ignores %s", (_name, change) => {
    expect(matchDeployConfirm("T1", { ...reaction, ...change }, relay, fullSetup)).toBeUndefined();
  });
  it("ignores a blocked channel and a foreign team", () => {
    expect(matchDeployConfirm("T1", reaction, { ...relay, blockedChannelIds: new Set(["C1"]) }, fullSetup)).toBeUndefined();
    expect(matchDeployConfirm("T2", reaction, relay, fullSetup)).toBeUndefined();
  });
  it("ignores a blocked owner", () => {
    expect(matchDeployConfirm("T1", reaction, { ...relay, blockedSenderIds: new Set(["ULUZ"]) }, fullSetup)).toBeUndefined();
  });
  it("is off without askBotUserId", () => {
    expect(matchDeployConfirm("T1", reaction, relay, deployCloseSetup(JSON.stringify(setup))!)).toBeUndefined();
  });
  it("defaults the reaction and marker and validates the emoji name", () => {
    expect(fullSetup.confirmReaction).toBe("white_check_mark");
    expect(fullSetup.askMarker).toBe("[deploy-close:v1]");
    expect(() => deployCloseSetup(JSON.stringify({ ...setup, confirmReaction: ":x:" }))).toThrow();
  });
});

describe("deploy close confirm admission", () => {
  it("ignores unmatched reactions without any outbound call", async () => {
    const f = fetcher();
    const response = await acceptSlack(signed({ ...reaction, user: "UOTHER" }), confirmEnv, f);
    expect(await response.json()).toEqual({ action: "ignored" });
    expect(f).not.toHaveBeenCalled();
  });
  it("ignores reactions when DEPLOY_CLOSE_SETUP is unset", async () => {
    const f = fetcher();
    const response = await acceptSlack(signed(reaction), base, f);
    expect(await response.json()).toEqual({ action: "ignored" });
    expect(f).not.toHaveBeenCalled();
  });
  it("ignores a reaction from a blocked owner without any outbound call", async () => {
    const f = fetcher();
    const response = await acceptSlack(signed(reaction), { ...confirmEnv, SLACK_BLOCKED_SENDER_IDS: "ULUZ" }, f);
    expect(await response.json()).toEqual({ action: "ignored" });
    expect(f).not.toHaveBeenCalled();
  });
  it("publishes a matched reaction once with a reaction dedup id", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const f = fetcher();
    const response = await acceptSlack(signed(reaction), confirmEnv, f);
    expect(await response.json()).toEqual({ action: "deploy_close_accepted", signal: "confirm" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe("https://qstash.upstash.io/v2/publish/https://relay.test/api/deploy-close/consume");
    expect((init!.headers as Record<string, string>)["Upstash-Deduplication-Id"]).toBe(
      digest("deploy-close:reaction:C1:200.000003:ULUZ:white_check_mark"),
    );
    expect(JSON.parse(String(init!.body))).toEqual({ kind: "confirm", teamId: "T1", event: reaction });
  });
});

describe("deploy close confirm consumer", () => {
  it("comments on the same thread with the reaction dedup key and confirm authorization", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const comment = mockExistingIssue();
    const f = confirmFetcher();
    const env = {
      ...confirmEnv,
      RELAY_AUTHORIZATION_SIGNING_KEY: "k".repeat(32),
      RELAY_AUTHORIZATION_POLICY: JSON.stringify({
        version: 1,
        policyId: "p",
        profiles: [{ id: "deploy-close-luz", intents: ["deploy_close"], actions: ["jira.read", "jira.transition"], senderIds: ["ULUZ"] }],
      }),
    };
    const response = await consumeDeployClose(consumeRequest(confirmBody), env, f);
    expect(await response.json()).toMatchObject({ action: "comment_persisted", issueId: "i1", phase: "confirm" });
    const content = comment.mock.calls[0]![2];
    expect(content).toContain(`relay-message:${digest("T1:C1:reaction:200.000003:ULUZ:white_check_mark")}`);
    expect(content).toContain('"phase": "confirm"');
    expect(content).toContain('"confirmedBy": "ULUZ"');
    expect(content).toContain('"jira.transition"');
    const asks = f.mock.calls.map(([u]) => new URL(String(u))).filter((u) => u.pathname.endsWith("conversations.replies"));
    expect(Object.fromEntries(asks[0]!.searchParams)).toEqual({
      channel: "C1", ts: "200.000003", oldest: "200.000003", latest: "200.000003", inclusive: "true", limit: "10",
    });
  });
  it.each([
    ["a root post", { ...askMessage, thread_ts: undefined }],
    ["the thread root itself", { ...askMessage, thread_ts: "200.000003" }],
    ["a message without the marker", { ...askMessage, text: "关单？" }],
    ["a message from another author", { ...askMessage, user: "UOTHER" }],
  ])("ignores a ✅ on %s", async (_n, ask) => {
    const create = vi.spyOn(api, "createIssue");
    const response = await consumeDeployClose(consumeRequest(confirmBody), confirmEnv, confirmFetcher(ask));
    expect(await response.json()).toEqual({ action: "ignored", reason: "not_ask_message" });
    expect(create).not.toHaveBeenCalled();
  });
  it("reports a duplicate delivery of the same reaction", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    mockExistingIssue();
    const f = confirmFetcher();
    const first = await consumeDeployClose(consumeRequest(confirmBody), confirmEnv, f);
    expect((await first.json()).action).toBe("comment_persisted");
    const second = await consumeDeployClose(consumeRequest(confirmBody), confirmEnv, f);
    expect((await second.json()).action).toBe("duplicate");
  });
  it("ignores a queued reaction whose owner was blocked meanwhile", async () => {
    const f = confirmFetcher();
    const response = await consumeDeployClose(consumeRequest(confirmBody), { ...confirmEnv, SLACK_BLOCKED_SENDER_IDS: "ULUZ" }, f);
    expect(await response.json()).toEqual({ action: "ignored", reason: "policy_changed" });
    expect(f).not.toHaveBeenCalled();
  });
  it("does not create an issue when the thread has none", async () => {
    vi.spyOn(api, "findIssue").mockResolvedValue(undefined);
    const create = vi.spyOn(api, "createIssue");
    const response = await consumeDeployClose(consumeRequest(confirmBody), confirmEnv, confirmFetcher());
    expect(await response.json()).toEqual({ action: "ignored", reason: "no_ask_issue" });
    expect(create).not.toHaveBeenCalled();
  });
  it("does not duplicate the comment when KV state is lost before a redelivery", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const comment = mockExistingIssue();
    const first = await consumeDeployClose(consumeRequest(confirmBody), confirmEnv, confirmFetcher());
    expect((await first.json()).action).toBe("comment_persisted");
    vi.spyOn(api, "findComment").mockResolvedValue({ id: "c1" } as api.MulticaComment);
    const second = await consumeDeployClose(consumeRequest(confirmBody), confirmEnv, confirmFetcher());
    expect((await second.json()).action).toBe("comment_persisted");
    expect(comment).toHaveBeenCalledTimes(1);
  });
  it("re-checks the reaction against current setup", async () => {
    const response = await consumeDeployClose(consumeRequest(confirmBody), enabled, confirmFetcher());
    expect(await response.json()).toEqual({ action: "ignored", reason: "policy_changed" });
  });
});
