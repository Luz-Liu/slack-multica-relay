import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptSlack } from "../src/http.js";
import {
  consumeDeployClose,
  deployCloseSetup,
  rootMentionsOwner,
} from "../src/deploy-close.js";
import * as api from "../src/multica-api.js";
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
      if (parts[0] === "EVAL") return Response.json({ result: 1 });
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
