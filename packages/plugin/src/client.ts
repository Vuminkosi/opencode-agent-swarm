/**
 * M1-04 versioned daemon client (`@opencode-swarm/plugin`).
 *
 * Speaks ONLY versioned daemon routes (contract C-DAEMON-01):
 * - `GET /healthz` (unauthenticated liveness, `{status,schemaVersion,protocolVersion}`)
 * - `GET /v1/swarms/:id`, `POST /v1/swarms`, `POST /v1/swarms/:id/members`,
 *   `POST /v1/swarms/:id/tasks`, `POST /v1/swarms/:id/posts`,
 *   `GET /v1/swarms/:id/posts?after=&limit=`,
 *   `POST /v1/swarms/:id/pause|resume|cancel`
 *
 * Any path outside `/healthz` + `/v1/` is rejected client-side so the
 * plugin can never drift onto an unversioned route. Errors surface the
 * daemon's safe `{error:{code,message}}` shape — never stack traces, SQL,
 * or file paths. Performs zero model inference: status reads are plain
 * `fetch` calls served from SQLite projections.
 */

export const DAEMON_API_PREFIX = "/v1/" as const;
export const DAEMON_HEALTH_PATH = "/healthz" as const;

export interface SwarmSummary {
  readonly id: string;
  readonly title: string;
  readonly coordinatorSessionId: string;
  readonly projectRoot: string;
  readonly mode: string;
  readonly status: string;
  readonly revision: number;
}

export interface MemberSummary {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly sessionId: string;
}

export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly ownerId: string | null;
}

export interface PostSummary {
  readonly id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly body: string;
}

export interface SwarmSnapshot {
  readonly swarm: SwarmSummary;
  readonly members: readonly MemberSummary[];
  readonly tasks: readonly TaskSummary[];
}

export class SwarmClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SwarmClientError";
    this.status = status;
    this.code = code;
  }
}

function assertVersionedPath(path: string): void {
  if (path === DAEMON_HEALTH_PATH) return;
  if (path.startsWith(DAEMON_API_PREFIX)) return;
  throw new SwarmClientError(400, "UNVERSIONED_ROUTE", `Refusing unversioned daemon route ${path}`);
}

export interface SwarmDaemonClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

export class SwarmDaemonClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SwarmDaemonClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init?: RequestInit & { auth?: boolean }): Promise<T> {
    assertVersionedPath(path);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init?.auth !== false) headers["authorization"] = `Bearer ${this.options.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new SwarmClientError(0, "DAEMON_UNREACHABLE", "Swarm daemon is unreachable");
    }
    if (!res.ok) {
      let code = "DAEMON_ERROR";
      let message = `Daemon request failed with HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (typeof body.error?.code === "string") code = body.error.code;
        if (typeof body.error?.message === "string") message = body.error.message;
      } catch {
        /* keep generic safe message */
      }
      throw new SwarmClientError(res.status, code, message);
    }
    return (await res.json()) as T;
  }

  /** Unauthenticated liveness; carries the contract shape, never inference. */
  health(): Promise<{ status: string; schemaVersion: number; protocolVersion: number }> {
    return this.request(DAEMON_HEALTH_PATH, { auth: false });
  }

  snapshot(swarmId: string): Promise<SwarmSnapshot> {
    return this.request<SwarmSnapshot>(`/v1/swarms/${encodeURIComponent(swarmId)}`, { auth: true });
  }

  createSwarm(input: { title: string; coordinatorSessionId: string; projectRoot: string; mode: string }): Promise<{
    swarm: SwarmSummary;
  }> {
    return this.request(`/v1/swarms`, { method: "POST", body: JSON.stringify(input), auth: true });
  }

  addMember(
    swarmId: string,
    input: { name: string; role: string; nativeAgentId: string; sessionId: string; model: { providerID: string; id: string } },
  ): Promise<{ member: MemberSummary }> {
    return this.request(`/v1/swarms/${encodeURIComponent(swarmId)}/members`, {
      method: "POST",
      body: JSON.stringify(input),
      auth: true,
    });
  }

  createTask(
    swarmId: string,
    input: { title: string; brief: string; ownerId?: string; ownedPaths?: string[]; forbiddenPaths?: string[]; acceptanceCriteria?: string[] },
  ): Promise<{ task: TaskSummary }> {
    return this.request(`/v1/swarms/${encodeURIComponent(swarmId)}/tasks`, {
      method: "POST",
      body: JSON.stringify(input),
      auth: true,
    });
  }

  appendPost(
    swarmId: string,
    input: { authorMemberId: string | null; kind: string; body: string; relatedTaskId?: string; idempotencyKey: string },
  ): Promise<{ post: PostSummary; deduped: boolean; wakeIds: string[] }> {
    return this.request(`/v1/swarms/${encodeURIComponent(swarmId)}/posts`, {
      method: "POST",
      body: JSON.stringify(input),
      auth: true,
    });
  }

  listPosts(swarmId: string, after = 0, limit = 100): Promise<{ posts: PostSummary[]; after: number }> {
    const query = `after=${encodeURIComponent(String(after))}&limit=${encodeURIComponent(String(limit))}`;
    return this.request(`/v1/swarms/${encodeURIComponent(swarmId)}/posts?${query}`, { auth: true });
  }

  pauseSwarm(swarmId: string): Promise<{ swarm: SwarmSummary }> {
    return this.request(`/v1/swarms/${encodeURIComponent(swarmId)}/pause`, { method: "POST", body: "{}", auth: true });
  }

  resumeSwarm(swarmId: string): Promise<{ swarm: SwarmSummary }> {
    return this.request(`/v1/swarms/${encodeURIComponent(swarmId)}/resume`, { method: "POST", body: "{}", auth: true });
  }

  cancelSwarm(swarmId: string): Promise<{ swarm: SwarmSummary }> {
    return this.request(`/v1/swarms/${encodeURIComponent(swarmId)}/cancel`, { method: "POST", body: "{}", auth: true });
  }
}
