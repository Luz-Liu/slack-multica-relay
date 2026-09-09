import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findComment,
  createIssue,
  getSlackReplyContext,
  type ApiConfig,
} from "../src/multica-api.js";
const config: ApiConfig = {
  multicaApiBaseUrl: "https://multica.test",
  multicaApiToken: "test",
  multicaWorkspaceId: "ws",
  multicaProjectId: "project",
  multicaAgentId: "agent",
};
afterEach(() => vi.restoreAllMocks());

describe("Agent configuration reply context", () => {
  it("does not present a legacy Agent model as the Team model", async () => {
    const f = vi.fn<typeof fetch>();
    expect(await getSlackReplyContext({ ...config, multicaAssigneeType: "squad", multicaAssigneeId: "team" }, f))
      .toMatchObject({ status: "unavailable", agentId: null, model: null });
    expect(f).not.toHaveBeenCalled();
  });
  it("uses the new Agent assignee instead of the legacy config", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "new-agent", workspace_id: "ws", model: "model" }));
    expect(await getSlackReplyContext({ ...config, multicaAssigneeId: "new-agent" }, f))
      .toMatchObject({ status: "available", agentId: "new-agent", model: "model" });
    expect(f.mock.calls[0]![0]).toBe("https://multica.test/api/agents/new-agent");
  });
  const agent = {
    id: "agent",
    workspace_id: "ws",
    model: "gpt-6-astra",
    service_tier: "priority",
  };

  it("reads the configured Agent with scoped auth and only exposes footer fields", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...agent,
        instructions: "private instructions",
        custom_env: { SECRET: "secret" },
      }),
    );
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const context = await getSlackReplyContext(config, f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe("https://multica.test/api/agents/agent");
    expect(f.mock.calls[0]![1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer test", "x-workspace-id": "ws" },
    });
    expect(timeout).toHaveBeenCalledWith(2000);
    expect(context).toEqual({
      type: "slack_reply_context",
      source: "agent_config",
      agentId: "agent",
      capturedAt: expect.any(String),
      status: "available",
      model: "gpt-6-astra",
      serviceTier: "priority",
    });
    expect(new Date(context.capturedAt).toISOString()).toBe(context.capturedAt);
  });

  it.each([
    ["gpt-6-astra", "default", "gpt-6-astra", "default"],
    ["", "", null, null],
    [null, null, null, null],
    [undefined, undefined, null, null],
    [" gpt-6-astra ", "future", "gpt-6-astra", null],
    [123, true, null, null],
    ["<!channel>", "priority", null, "priority"],
    ["x".repeat(201), "default", null, "default"],
  ])(
    "normalizes model %j and tier %j without guessing",
    async (model, tier, expectedModel, expectedTier) => {
      const result = await getSlackReplyContext(config, async () =>
        Response.json({ ...agent, model, service_tier: tier }),
      );
      expect(result).toMatchObject({
        status: "available", model: expectedModel, serviceTier: expectedTier,
      });
    },
  );

  it.each([null, [], {}, { ...agent, id: "other" }, { ...agent, workspace_id: "other" }])(
    "does not trust malformed or out-of-scope Agent responses: %j",
    async (body) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await getSlackReplyContext(config, async () => Response.json(body));
      expect(result).toMatchObject({
        status: "unavailable", model: null, serviceTier: null,
      });
    },
  );

  it.each([401, 403, 404, 429, 500])(
    "treats HTTP %s as optional failure without retries",
    async (status) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const f = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("private upstream body", { status }),
      );
      expect(await getSlackReplyContext(config, f)).toMatchObject({
        status: "unavailable", model: null, serviceTier: null,
      });
      expect(f).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private upstream body");
    },
  );

  it.each([
    new Error("private transport detail"),
    new DOMException("private timeout detail", "TimeoutError"),
  ])(
    "does not fail the reply context request or leak transport details",
    async (error) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const f = vi.fn<typeof fetch>().mockRejectedValue(error);
      expect(await getSlackReplyContext(config, f)).toMatchObject({
        status: "unavailable", model: null, serviceTier: null,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(error.message);
    },
  );

  it("treats invalid JSON as unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await getSlackReplyContext(config, async () => new Response("invalid json"));
    expect(result).toMatchObject({ status: "unavailable", model: null, serviceTier: null });
  });
});
describe("Multica API contract", () => {
  it("uses ordinary Issue creation with unique title and no Autopilot", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "issue", title: "Slack C1 1" }));
    await createIssue(config, "Slack C1 1", "marker", f);
    expect(f.mock.calls[0]![0]).toBe("https://multica.test/api/issues");
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toMatchObject({
      project_id: "project",
      assignee_id: "agent",
      assignee_type: "agent",
    });
  });
  it("follows Multica comment cursor headers when recovering writes", async () => {
    let calls = 0;
    const f: typeof fetch = async (input) => {
      calls++;
      if (calls === 1)
        return Response.json([], {
          headers: {
            "X-Multica-Next-Before": "2026-09-01T00:00:00Z",
            "X-Multica-Next-Before-Id": "old",
          },
        });
      expect(String(input)).toContain("before_id=old");
      return Response.json([{ id: "c", content: "marker" }]);
    };
    expect((await findComment(config, "issue", "marker", f))?.id).toBe("c");
    expect(calls).toBe(2);
  });
  it("rejects malformed list instead of treating missing evidence as no match", async () => {
    await expect(
      findComment(config, "issue", "marker", async () =>
        Response.json({ unexpected: [] }),
      ),
    ).rejects.toThrow("invalid_multica_response");
  });
  it("accepts same-time cursor advancement with different IDs", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return calls < 3
        ? Response.json([], {
            headers: {
              "X-Multica-Next-Before": "2026-09-01T00:00:00Z",
              "X-Multica-Next-Before-Id": "id-" + calls,
            },
          })
        : Response.json([{ id: "c", content: "marker" }]);
    };
    expect((await findComment(config, "issue", "marker", fetcher))?.id).toBe(
      "c",
    );
  });
});

describe("Team API", () => {
  const team = { ...config, multicaAssigneeType: "squad" as const, multicaAssigneeId: "team" };
  it("writes squad assignment", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "i", title: "t" }));
    await createIssue(team, "t", "marker", f);
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toMatchObject({ assignee_type: "squad", assignee_id: "team" });
  });
  it.each(["squad", "agent"])("checks 409 ownership type %s", async (type) => {
    const f: typeof fetch = async () => Response.json({ code: "active_duplicate_issue", issue: { id: "i", title: "t", project_id: "project", assignee_type: type, assignee_id: "team", description: "marker\nbody" } }, { status: 409 });
    if (type === "squad") expect((await createIssue(team, "t", "marker\nbody", f)).id).toBe("i");
    else await expect(createIssue(team, "t", "marker\nbody", f)).rejects.toThrow("multica_http_error");
  });
});
