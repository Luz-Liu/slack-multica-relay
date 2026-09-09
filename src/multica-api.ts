export interface MulticaIssue {
  id: string;
  title: string;
  description?: string | null;
  project_id?: string | null;
  assignee_id?: string | null;
  assignee_type?: string | null;
}
export interface MulticaComment {
  id: string;
  content: string;
  trigger_outcomes?: unknown;
}
export interface ApiConfig {
  multicaApiBaseUrl: string;
  multicaApiToken: string;
  multicaWorkspaceId: string;
  multicaProjectId: string;
  multicaAgentId?: string;
  multicaAssigneeType?: "agent" | "squad";
  multicaAssigneeId?: string;
  multicaThreadScopeId?: string;
  multicaLegacyAgentId?: string;
}
export function assignee(config: ApiConfig): { type: "agent" | "squad"; id: string } {
  const type = config.multicaAssigneeType ?? "agent";
  const id = config.multicaAssigneeId ?? (type === "agent" ? config.multicaAgentId : undefined);
  if (!id) throw new Error("relay_not_configured");
  return { type, id };
}
export function threadScopeId(config: ApiConfig): string {
  const target = assignee(config);
  return config.multicaThreadScopeId ?? (target.type === "agent" ? target.id : `squad:${target.id}`);
}
function ownsIssue(config: ApiConfig, candidate: MulticaIssue): boolean {
  const target = assignee(config);
  return candidate.project_id === config.multicaProjectId && (
    (candidate.assignee_type === target.type && candidate.assignee_id === target.id) ||
    (target.type === "squad" && !!config.multicaLegacyAgentId &&
      config.multicaThreadScopeId === config.multicaLegacyAgentId &&
      candidate.assignee_type === "agent" && candidate.assignee_id === config.multicaLegacyAgentId)
  );
}
export async function validateMappedIssue(config: ApiConfig, id: string, marker: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await api(config, `/api/issues/${encodeURIComponent(id)}`, {}, fetchImpl);
  if (!response.ok) throw new ApiError(response.status);
  const candidate = issue(await response.json());
  if (candidate.id !== id || !ownsIssue(config, candidate) || !candidate.description?.startsWith(marker + "\n"))
    throw new Error("invalid_issue_scope");
}
export interface SlackReplyContext {
  type: "slack_reply_context";
  source: "agent_config";
  agentId: string | null;
  capturedAt: string;
  status: "available" | "unavailable";
  model: string | null;
  serviceTier: "priority" | "default" | null;
}
export class ApiError extends Error {
  constructor(readonly status: number) {
    super("multica_http_error");
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function issue(value: unknown): MulticaIssue {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string"
  )
    throw new Error("invalid_multica_response");
  return value as unknown as MulticaIssue;
}
async function api(
  config: ApiConfig,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(config.multicaApiBaseUrl + path, {
    ...init,
    headers: {
      authorization: `Bearer ${config.multicaApiToken}`,
      "content-type": "application/json",
      "x-workspace-id": config.multicaWorkspaceId,
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(8000),
  });
}
export async function getSlackReplyContext(
  config: ApiConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackReplyContext> {
  const target = assignee(config);
  // A Team may delegate to multiple agents; a legacy Agent snapshot is misleading.
  if (target.type === "squad") return {
    type: "slack_reply_context", source: "agent_config", agentId: null,
    capturedAt: new Date().toISOString(), status: "unavailable",
    model: null, serviceTier: null,
  };
  const agentId = target.id;
  let model: string | null = null;
  let serviceTier: SlackReplyContext["serviceTier"] = null;
  let status: SlackReplyContext["status"] = "unavailable";
  try {
    const response = await api(
      config,
      `/api/agents/${encodeURIComponent(agentId)}`,
      { signal: AbortSignal.timeout(2000), redirect: "error" },
      fetchImpl,
    );
    if (!response.ok) throw new ApiError(response.status);
    const body: unknown = await response.json();
    if (
      !object(body) ||
      body.id !== agentId ||
      body.workspace_id !== config.multicaWorkspaceId
    )
      throw new Error("invalid_multica_response");
    // 仅透传可展示的配置字段，避免把指令、凭据或 Slack 标记带入 footer。
    const candidate = typeof body.model === "string" ? body.model.trim() : "";
    if (/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u.test(candidate))
      model = candidate;
    if (body.service_tier === "priority" || body.service_tier === "default")
      serviceTier = body.service_tier;
    status = "available";
  } catch {
    // footer 是可选信息；查询失败不阻断任务，也不输出上游响应或异常正文。
    console.warn("relay_reply_context", { reason: "agent_config_unavailable" });
  }
  return {
    type: "slack_reply_context",
    source: "agent_config",
    agentId,
    capturedAt: new Date().toISOString(),
    status,
    model,
    serviceTier,
  };
}
export async function findIssue(
  config: ApiConfig,
  marker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MulticaIssue | undefined> {
  for (let offset = 0; offset < 10000; offset += 100) {
    const query = new URLSearchParams({
      project_id: config.multicaProjectId,
      limit: "100",
      offset: String(offset),
      sort: "created_at",
      direction: "asc",
    });
    const response = await api(config, "/api/issues?" + query, {}, fetchImpl);
    if (!response.ok) throw new ApiError(response.status);
    const body: unknown = await response.json();
    if (!object(body) || !Array.isArray(body.issues))
      throw new Error("invalid_multica_response");
    const rows = body.issues.map(issue);
    const matches = rows.filter((x) =>
      x.description?.startsWith(marker + "\n"),
    );
    if (matches.length > 1) throw new Error("ambiguous_issue_mapping");
    if (matches[0]) {
      const candidate = matches[0];
      if (
        !ownsIssue(config, candidate)
      )
        throw new Error("invalid_issue_scope");
      return candidate;
    }
    if (rows.length < 100) return;
  }
  throw new Error("issue_lookup_limit");
}
export async function createIssue(
  config: ApiConfig,
  title: string,
  description: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MulticaIssue> {
  const response = await api(
    config,
    "/api/issues",
    {
      method: "POST",
      body: JSON.stringify({
        title,
        description,
        project_id: config.multicaProjectId,
        assignee_type: assignee(config).type,
        assignee_id: assignee(config).id,
        status: "todo",
      }),
    },
    fetchImpl,
  );
  if (response.status === 409) {
    const body: unknown = await response.json();
    if (
      object(body) &&
      body.code === "active_duplicate_issue" &&
      object(body.issue)
    ) {
      const existing = issue(body.issue),
        marker = description.split("\n")[0]!;
      if (
        ownsIssue(config, existing) &&
        existing.description?.startsWith(marker + "\n")
      )
        return existing;
    }
    throw new ApiError(409);
  }
  if (!response.ok) throw new ApiError(response.status);
  return issue(await response.json());
}
export async function findComment(
  config: ApiConfig,
  issueId: string,
  marker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MulticaComment | undefined> {
  let before = "",
    beforeId = "";
  for (let page = 0; page < 50; page++) {
    const query = new URLSearchParams({ recent: "100" });
    if (before) {
      query.set("before", before);
      query.set("before_id", beforeId);
    }
    const response = await api(
      config,
      `/api/issues/${encodeURIComponent(issueId)}/comments?${query}`,
      {},
      fetchImpl,
    );
    if (!response.ok) throw new ApiError(response.status);
    const body: unknown = await response.json();
    if (
      !Array.isArray(body) ||
      body.some(
        (x) =>
          !object(x) ||
          typeof x.id !== "string" ||
          typeof x.content !== "string",
      )
    )
      throw new Error("invalid_multica_response");
    const match = (body as MulticaComment[]).find((x) =>
      x.content.includes(marker),
    );
    if (match) return match;
    const next = response.headers.get("X-Multica-Next-Before");
    const nextId = response.headers.get("X-Multica-Next-Before-Id");
    if (!next && !nextId) return;
    if (!next || !nextId || (next === before && nextId === beforeId))
      throw new Error("invalid_comment_cursor");
    before = next;
    beforeId = nextId;
  }
  throw new Error("comment_lookup_limit");
}
export async function createComment(
  config: ApiConfig,
  issueId: string,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MulticaComment> {
  const response = await api(
    config,
    `/api/issues/${encodeURIComponent(issueId)}/comments`,
    { method: "POST", body: JSON.stringify({ content, type: "comment" }) },
    fetchImpl,
  );
  if (!response.ok) throw new ApiError(response.status);
  const body: unknown = await response.json();
  if (
    !object(body) ||
    typeof body.id !== "string" ||
    typeof body.content !== "string"
  )
    throw new Error("invalid_multica_response");
  return body as unknown as MulticaComment;
}
