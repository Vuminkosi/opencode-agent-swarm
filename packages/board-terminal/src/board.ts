/**
 * M6-02 standalone terminal board — read-only fallback surface (spec §§11, 3,
 * 5-8, 12 + §4.4 fallback).
 *
 * Why this package exists as the PRIMARY surface until the native TUI probe
 * (M6-03) proves otherwise: the native OpenCode TUI cannot yet embed the
 * swarm board (chronological public stream + roster + wake/delivery +
 * tasks/verifier/monitor + usage) without risking daemon coupling or
 * inference side effects. This module renders the same read models as plain
 * text over sequence cursors, so it works in any terminal today, survives an
 * OpenCode restart via journal replay (sequences, never assumed offsets),
 * and provably submits zero turns.
 *
 * Read-only by construction:
 * - No import of the runtime store, daemon, harness, or ledger writer. The
 *   `BoardReader` port below is the ONLY data entry point; producers adapt
 *   the durable journal + wake rows + usage totals into it.
 * - No `submitTurn`, no network, no inference, no mutation, no persistence.
 *   Renderer signatures accept public `BoardPost[]` only — private
 *   user→worker steering (`PrivateInput`) has no parameter slot anywhere in
 *   the render path, so it can never leak onto the public board.
 * - Costs/tokens are ACTUAL recorded values only (`costMicro` as stored, 0
 *   means unobserved and is labelled as such — never estimated).
 */

export type PostKind =
  | "brief"
  | "message"
  | "question"
  | "progress"
  | "result"
  | "verification"
  | "monitor"
  | "done"
  | "system";

export type InternalMemberState =
  | "starting"
  | "working"
  | "waiting"
  | "quota_paused"
  | "approval_paused"
  | "recovering"
  | "killed";

export type PublicMemberState = "working" | "waiting" | "killed";

export type WakeState =
  | "queued"
  | "admitted"
  | "observed_running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WakeReason =
  | "mention"
  | "assigned_task"
  | "verifier_request"
  | "monitor_intervention"
  | "user_direct";

/** Structural mirror of the protocol BoardPost (local: no daemon dep). */
export interface BoardPost {
  readonly id: string;
  readonly swarmId: string;
  readonly sequence: number;
  readonly authorMemberId: string | null;
  readonly kind: PostKind;
  readonly body: string;
  /** Canonical live member ids addressed (resolved at commit time). */
  readonly mentions: readonly string[];
  /** Canonical group names that resolved (for @group rendering). */
  readonly groupMentions: readonly string[];
  readonly mentionAll: boolean;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly relatedTaskId: string | null;
}

/** Structural mirror of the protocol Member (local: no daemon dep).
 *
 * NOTE (free-form strings, not enums): `role` is an open host-assigned label
 * (e.g. "coder", "reviewer") — never a closed enum. Renderers must print it
 * verbatim (verbose lines) or omit it (default lines), never switch on it.
 */
export interface BoardMember {
  readonly id: string;
  readonly swarmId: string;
  readonly name: string;
  readonly groups: readonly string[];
  readonly role: string;
  readonly nativeAgentId: string;
  readonly sessionId: string;
  readonly model: { readonly providerID: string; readonly id: string };
  readonly publicState: PublicMemberState;
  readonly internalState: InternalMemberState;
  readonly generation: number;
  readonly lastActivityAt: string;
  readonly killedAt: string | null;
}

export interface BoardTask {
  readonly id: string;
  readonly swarmId: string;
  readonly title: string;
  readonly brief: string;
  readonly ownerId: string | null;
  readonly deps: readonly string[];
  /**
   * NOTE (free-form string, not an enum): task lifecycle states are protocol
   * strings ("ready", "blocked", "accepted", …) that may grow. Renderers map
   * known states to human words and pass anything else through verbatim —
   * never an exhaustive switch, never a render failure on unknown states.
   */
  readonly state: string;
  readonly attempt: number;
  readonly generation: number;
  readonly resultEvidenceIds: readonly string[];
}

export interface BoardWake {
  readonly id: string;
  readonly swarmId: string;
  readonly memberId: string;
  readonly memberGeneration: number;
  readonly reason: WakeReason;
  readonly postSequence: number | null;
  readonly taskId: string | null;
  readonly payloadHash: string;
  readonly state: WakeState;
  readonly attempts: number;
  readonly createdAt: string;
  /** Adapter-internal correlation id carried verbatim (refs only). */
  readonly correlationId?: string;
}

export interface BoardEvidence {
  readonly id: string;
  readonly taskId: string;
  readonly executorMemberId: string;
  readonly command: string;
  readonly exitCode: number;
  readonly commitSha: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** One recorded provider/model rollup (ACTUAL observed values only). */
export interface BoardUsageTotals {
  readonly providerId: string;
  readonly modelId: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Observed cost in micro-units; 0 = unobserved (never estimated). */
  readonly costMicro: number;
}

/**
 * Private user→worker steering. Exists ONLY so tests can prove the negative:
 * no renderer below accepts this type, so private input can never reach the
 * public board. There is intentionally no `renderPrivate` function.
 */
export interface PrivateInput {
  readonly toMemberId: string;
  readonly body: string;
  readonly createdAt: string;
}

/**
 * Minimal read port. Producers (journal adapter, fake harness in tests)
 * implement this; the board never touches the store, daemon, or ledger
 * writer. All reads are sequence/cursor based — never assumed offsets.
 */
export interface BoardReader {
  getPostsAfter(swarmId: string, afterSequence: number, limit?: number): BoardPost[];
  listMembers(swarmId: string): BoardMember[];
  listTasks(swarmId: string): BoardTask[];
  /** Wakes in one state (e.g. "queued") for delivery-status columns. */
  listWakes(swarmId: string, state: WakeState, limit?: number): BoardWake[];
  listUnsettledWakes(swarmId: string, limit?: number): BoardWake[];
  /**
   * Latest live (admitted/observed_running) wake for a member generation.
   * `memberGeneration` is optional for backward compatibility; callers that
   * know the member's current generation MUST pass it so a stale wake from a
   * previous generation can never shadow the current one (D-03).
   */
  findLiveWakeForMember(memberId: string, memberGeneration?: number): BoardWake | null;
  listEvidenceForTask(taskId: string): BoardEvidence[];
  listUsageTotals(): BoardUsageTotals[];
}

/**
 * Counts model-turn submissions. The board NEVER receives one of these —
 * tests hold a `FakeHarness` beside the board and assert its counter stays
 * at zero after every read/render/reconnect, proving zero-inference reads.
 */
export interface TurnSubmitTracker {
  readonly submits: number;
}

export class FakeHarness implements TurnSubmitTracker {
  private count = 0;
  get submits(): number {
    return this.count;
  }
  /** Simulated dispatch entry point — the board never calls this. */
  submitTurn(): never {
    this.count += 1;
    throw new Error("FakeHarness.submitTurn must never be called by board reads (simulated, no inference)");
  }
  markExternalSubmit(): void {
    this.count += 1;
  }
}

/** In-memory BoardReader for tests and offline rendering. */
export class InMemoryBoardSource implements BoardReader {
  private readonly posts: BoardPost[];
  private readonly members: BoardMember[];
  private readonly tasks: BoardTask[];
  private readonly wakes: BoardWake[];
  private readonly evidence: BoardEvidence[];
  private readonly usage: BoardUsageTotals[];

  constructor(input: {
    readonly posts?: readonly BoardPost[];
    readonly members?: readonly BoardMember[];
    readonly tasks?: readonly BoardTask[];
    readonly wakes?: readonly BoardWake[];
    readonly evidence?: readonly BoardEvidence[];
    readonly usage?: readonly BoardUsageTotals[];
  } = {}) {
    this.posts = [...(input.posts ?? [])].sort((a, b) => a.sequence - b.sequence);
    this.members = [...(input.members ?? [])];
    this.tasks = [...(input.tasks ?? [])];
    this.wakes = [...(input.wakes ?? [])];
    this.evidence = [...(input.evidence ?? [])];
    this.usage = [...(input.usage ?? [])];
  }

  getPostsAfter(swarmId: string, afterSequence: number, limit = 100): BoardPost[] {
    return this.posts
      .filter((p) => p.swarmId === swarmId && p.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit);
  }

  listMembers(swarmId: string): BoardMember[] {
    return this.members.filter((m) => m.swarmId === swarmId);
  }

  listTasks(swarmId: string): BoardTask[] {
    return this.tasks.filter((t) => t.swarmId === swarmId);
  }

  listWakes(swarmId: string, state: WakeState, limit = 100): BoardWake[] {
    return this.wakes.filter((w) => w.swarmId === swarmId && w.state === state).slice(0, limit);
  }

  listUnsettledWakes(swarmId: string, limit = 100): BoardWake[] {
    return this.wakes
      .filter((w) => w.swarmId === swarmId && (w.state === "admitted" || w.state === "observed_running"))
      .slice(0, limit);
  }

  findLiveWakeForMember(memberId: string, memberGeneration?: number): BoardWake | null {
    return (
      this.wakes.find(
        (w) =>
          w.memberId === memberId &&
          (memberGeneration === undefined || w.memberGeneration === memberGeneration) &&
          (w.state === "admitted" || w.state === "observed_running"),
      ) ?? null
    );
  }

  listEvidenceForTask(taskId: string): BoardEvidence[] {
    return this.evidence.filter((e) => e.taskId === taskId);
  }

  listUsageTotals(): BoardUsageTotals[] {
    return [...this.usage];
  }
}

// --- Name resolution (canonical IDs, never raw text) ---

export function memberNameById(members: readonly BoardMember[], id: string | null): string {
  if (id === null) return "system";
  return members.find((m) => m.id === id)?.name ?? "unknown";
}

/**
 * Canonical recipient rendering for one post: resolved member names from
 * `mentions` ids, `@group` from `groupMentions`, `@all` from `mentionAll`.
 * Raw body text is never parsed here — the journal resolved mentions at
 * commit time against an immutable membership snapshot.
 */
export function renderRecipients(post: BoardPost, members: readonly BoardMember[]): string {
  const parts: string[] = [];
  for (const id of post.mentions) {
    parts.push(`@${memberNameById(members, id)}`);
  }
  for (const group of post.groupMentions) {
    parts.push(`@${group}`);
  }
  if (post.mentionAll) parts.push("@all");
  return parts.length === 0 ? "woke nobody" : parts.join(" ");
}

/** Single chronological stream line: `#seq author [kind] body → recipients`.
 *
 * Human default hides the raw related-task id (`task=t-N` is verbose-only —
 * the default surface never leaks raw ids). Pass `verbose=true` (the
 * `--verbose` surface) to include `task=<id>` for cross-referencing.
 */
export function renderPostLine(post: BoardPost, members: readonly BoardMember[], verbose = false): string {
  const author = memberNameById(members, post.authorMemberId);
  const taskRef = verbose && post.relatedTaskId !== null ? ` task=${post.relatedTaskId}` : "";
  return `#${post.sequence} ${author} [${post.kind}]${taskRef} ${post.body} → ${renderRecipients(post, members)}`;
}

// --- Roster ---

export interface RosterRow {
  readonly member: BoardMember;
  readonly hasLiveTurn: boolean;
  readonly liveWakeId: string | null;
  readonly assignedTaskIds: readonly string[];
}

export function buildRoster(reader: BoardReader, swarmId: string): RosterRow[] {
  const members = reader.listMembers(swarmId);
  const tasks = reader.listTasks(swarmId);
  return members.map((member) => {
    // Generation-pinned: a live wake from an older generation (member
    // restarted since) must not mark the current generation as live.
    const live = reader.findLiveWakeForMember(member.id, member.generation);
    return {
      member,
      hasLiveTurn: live !== null,
      liveWakeId: live?.id ?? null,
      assignedTaskIds: tasks.filter((t) => t.ownerId === member.id).map((t) => t.id),
    };
  });
}

function supplementaryLabel(state: InternalMemberState): string {
  switch (state) {
    case "starting":
      return "starting";
    case "recovering":
      return "recovering";
    case "quota_paused":
      return "paused:quota";
    case "approval_paused":
      return "paused:approval";
    case "working":
    case "waiting":
    case "killed":
      return state;
  }
}

/**
 * Human-readable member-state label for the default (non-verbose) roster.
 * Internal states are user concepts, not DTO dumps: quota/approval pauses
 * share the "Paused" word with a distinct suffix; `killed` renders as
 * "Ended" (the membership ended — never raw `killed`/`null` jargon).
 */
function humanStateLabel(state: InternalMemberState): string {
  switch (state) {
    case "working":
      return "Working";
    case "waiting":
      return "Waiting";
    case "quota_paused":
      return "Paused—quota";
    case "approval_paused":
      return "Paused—approval";
    case "starting":
      return "Starting";
    case "recovering":
      return "Recovering";
    case "killed":
      return "Ended";
  }
}

/**
 * Default roster line is human-first and compact (≤80 chars): name, state,
 * liveness, and task COUNT only. Raw ids (role, native agent id, model,
 * session, task ids, wake ids) appear only with `verbose=true` (the
 * `--verbose` surface owned by the host CLI — key handling stays host-side).
 */
export function renderRosterLine(row: RosterRow, verbose = false): string {
  const m = row.member;
  const taskCount = row.assignedTaskIds.length;
  const taskBits = taskCount === 0 ? "no tasks" : taskCount === 1 ? "1 task" : `${taskCount} tasks`;
  const head = `${m.name} — ${humanStateLabel(m.internalState)}, ${row.hasLiveTurn ? "live" : "idle"}, ${taskBits}`;
  if (!verbose) return head;
  const turn = row.hasLiveTurn ? `live-turn=${row.liveWakeId ?? "?"}` : "idle";
  const tasks = row.assignedTaskIds.length === 0 ? "no-task" : `tasks=[${row.assignedTaskIds.join(",")}]`;
  return (
    `${head} | (${m.role}/${m.nativeAgentId}) model=${m.model.providerID}/${m.model.id} ` +
    `state=${supplementaryLabel(m.internalState)} public=${m.publicState} ${turn} ${tasks} session=${m.sessionId}`
  );
}

// --- Filtering ---

export interface BoardFilter {
  readonly memberId?: string;
  readonly kind?: PostKind;
  readonly search?: string;
}

export function filterPosts(
  posts: readonly BoardPost[],
  members: readonly BoardMember[],
  filter: BoardFilter,
): BoardPost[] {
  const needle = filter.search?.toLowerCase();
  return posts.filter((p) => {
    if (filter.memberId !== undefined) {
      const name = memberNameById(members, filter.memberId).toLowerCase();
      const authorMatch = p.authorMemberId === filter.memberId;
      const recipientMatch = p.mentions.includes(filter.memberId);
      const textMatch =
        needle !== undefined && (p.body.toLowerCase().includes(`@${name}`) || p.body.toLowerCase().includes("@all"));
      if (!authorMatch && !recipientMatch && !textMatch) return false;
    }
    if (filter.kind !== undefined && p.kind !== filter.kind) return false;
    if (needle !== undefined && needle !== "" && !p.body.toLowerCase().includes(needle)) return false;
    return true;
  });
}

// --- Delivery / wake status ---

/**
 * Normalized logical-action key (mirrors the journal delivery_key shape).
 *
 * NOTE (preimage vs hash): this key is a human-debuggable PREIMAGE string —
 * the pipe-joined identity fields of one logical action. It is NOT itself a
 * hash. The final segment, `payloadHash`, is the content hash of the wake
 * payload; the key embeds that hash verbatim so duplicate transports of the
 * same action collapse without an extra hashing step.
 */
export function deliveryKeyOf(wake: BoardWake): string {
  const postPart = wake.postSequence ?? 0;
  const taskPart = wake.taskId ?? "0";
  return `${wake.memberId}|${wake.memberGeneration}|${wake.reason}|${postPart}|${taskPart}|${wake.payloadHash}`;
}

export interface DeliveryRow {
  /** One logical action (duplicate delivery_key rows collapsed). */
  readonly deliveryKey: string;
  readonly memberId: string;
  readonly reason: WakeReason;
  readonly postSequence: number | null;
  readonly taskId: string | null;
  readonly state: WakeState;
  readonly attempts: number;
  readonly correlationId: string | null;
  /** Physical rows collapsed into this logical action (>1 = dedupe proof). */
  readonly collapsed: number;
}

/**
 * Collapse duplicate wake rows by delivery key into single logical actions.
 * Visible proof of exactly-once-logical fanout: `collapsed > 1` means the
 * transport redelivered but the board shows one action.
 *
 * Survivor rule (progression order): the most-progressed row wins —
 * succeeded > failed > cancelled > observed_running > admitted > queued —
 * so a terminal outcome is never shadowed by a stale queued duplicate.
 */
export function collapseWakes(wakes: readonly BoardWake[]): DeliveryRow[] {
  const byKey = new Map<string, BoardWake[]>();
  for (const w of wakes) {
    const key = deliveryKeyOf(w);
    const list = byKey.get(key) ?? [];
    list.push(w);
    byKey.set(key, list);
  }
  const order: Record<WakeState, number> = {
    queued: 0,
    admitted: 1,
    observed_running: 2,
    cancelled: 3,
    failed: 4,
    succeeded: 5,
  };
  return [...byKey.entries()]
    .map(([deliveryKey, rows]) => {
      const sorted = [...rows].sort((a, b) => order[a.state] - order[b.state]);
      const head = sorted[sorted.length - 1] as BoardWake;
      return {
        deliveryKey,
        memberId: head.memberId,
        reason: head.reason,
        postSequence: head.postSequence,
        taskId: head.taskId,
        state: head.state,
        attempts: Math.max(...rows.map((r) => r.attempts)),
        correlationId: head.correlationId ?? null,
        collapsed: rows.length,
      };
    })
    .sort((a, b) => (a.deliveryKey < b.deliveryKey ? -1 : 1));
}

/** Human-readable wake state (default delivery lines never show raw codes). */
function humanWakeState(state: WakeState): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "admitted":
      return "Admitted";
    case "observed_running":
      return "Running";
    case "succeeded":
      return "Delivered";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/** Human-readable wake reason. */
function humanWakeReason(reason: WakeReason): string {
  switch (reason) {
    case "mention":
      return "mention";
    case "assigned_task":
      return "task assignment";
    case "verifier_request":
      return "verification request";
    case "monitor_intervention":
      return "monitor";
    case "user_direct":
      return "direct";
  }
}

/**
 * Default delivery line in human words (`Delivered`/`Running`/…, `attempt N`,
 * null correlation hidden entirely). Raw codes (delivery key, member id,
 * correlation id, task id, state/reason codes) appear only with
 * `verbose=true`. The default line never names a raw task id.
 *
 * NOTE (correlationId provenance): the correlation id is adapter-internal
 * metadata carried verbatim from the journal for cross-referencing only. It
 * is never parsed, never used for routing/dedupe, and hidden by default.
 */
export function renderDeliveryLine(row: DeliveryRow, members: readonly BoardMember[], verbose = false): string {
  const name = memberNameById(members, row.memberId);
  const post = row.postSequence === null ? "no post" : `post #${row.postSequence}`;
  const dupe = row.collapsed > 1 ? ` (×${row.collapsed} merged)` : "";
  const head = `@${name} — ${humanWakeReason(row.reason)}, ${post}: ${humanWakeState(row.state)}, attempt ${row.attempts}${dupe}`;
  if (!verbose) return head;
  const task = row.taskId === null ? "task=—" : `task=${row.taskId}`;
  const corr = row.correlationId === null ? "corr=—" : `corr=${row.correlationId}`;
  return `${head} | ${task} key=${row.deliveryKey} state=${row.state} reason=${row.reason} member=${row.memberId} ${corr}`;
}

/** Post → recipients → wake-state view for one post. */
export function deliveryForPost(post: BoardPost, wakes: readonly BoardWake[]): DeliveryRow[] {
  return collapseWakes(wakes.filter((w) => w.postSequence === post.sequence));
}

// --- Tasks / verifier / remediation / monitor ---

export interface TaskView {
  readonly task: BoardTask;
  readonly ownerName: string;
  readonly depsSatisfied: boolean;
  readonly blocked: boolean;
  readonly passingEvidence: number;
  readonly failingEvidence: number;
  readonly defectPostSequences: readonly number[];
  readonly monitorWake: boolean;
}

export function buildTaskViews(
  reader: BoardReader,
  swarmId: string,
  posts: readonly BoardPost[],
  wakes: readonly BoardWake[],
): TaskView[] {
  const members = reader.listMembers(swarmId);
  const tasks = reader.listTasks(swarmId);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.map((task) => {
    const evidence = reader.listEvidenceForTask(task.id);
    const passingEvidence = evidence.filter((e) => e.exitCode === 0).length;
    const failingEvidence = evidence.filter((e) => e.exitCode !== 0).length;
    const depsSatisfied = task.deps.every((d) => byId.get(d)?.state === "accepted");
    const defectPostSequences = posts
      .filter((p) => p.relatedTaskId === task.id && p.kind === "verification")
      .map((p) => p.sequence);
    // State-insensitive by construction: ANY wake with reason
    // monitor_intervention counts (queued, running, or already terminal).
    // Callers must pass every wake visible for the task — never a
    // state-prefiltered subset — or monitor history goes silent.
    const monitorWake = wakes.some((w) => w.taskId === task.id && w.reason === "monitor_intervention");
    return {
      task,
      ownerName: task.ownerId === null ? "Unassigned" : memberNameById(members, task.ownerId),
      depsSatisfied,
      blocked: task.state === "blocked",
      passingEvidence,
      failingEvidence,
      defectPostSequences,
      monitorWake,
    };
  });
}

/** Human-readable task state; unknown protocol states pass through verbatim. */
function humanTaskState(state: string): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "blocked":
      return "Blocked";
    case "accepted":
      return "Done";
    case "in_progress":
      return "In progress";
    default:
      return state;
  }
}

/**
 * Default task line is human-first: title, human state, owner name, attempt,
 * dependency readiness, check counts, defect-post refs, monitor note. Raw
 * ids (task/dep ids) and machine codes appear only with `verbose=true`.
 */
export function renderTaskLine(view: TaskView, verbose = false): string {
  const t = view.task;
  const deps =
    t.deps.length === 0 ? "no dependencies" : view.depsSatisfied ? "dependencies ready" : "waiting on dependencies";
  const evidence = `checks ${view.passingEvidence} pass / ${view.failingEvidence} fail`;
  const remediation =
    view.defectPostSequences.length === 0
      ? ""
      : `, defects in ${view.defectPostSequences.map((s) => `#${s}`).join(", ")}`;
  const monitor = view.monitorWake ? ", monitor stepped in" : "";
  const head = `"${t.title}" — ${humanTaskState(t.state)}, owner ${view.ownerName}, attempt ${t.attempt}, ${deps}, ${evidence}${remediation}${monitor}`;
  if (!verbose) return head;
  const depIds = t.deps.length === 0 ? "deps=—" : `deps=[${t.deps.join(",")}]${view.depsSatisfied ? ":ok" : ":waiting"}`;
  return `${head} | id=${t.id} state=${t.state} owner=${t.ownerId ?? "—"} ${depIds}`;
}

// --- Usage ledger presentation (recorded-only) ---

export function renderUsageLine(totals: BoardUsageTotals): string {
  const dollars = (totals.costMicro / 1_000_000).toFixed(6);
  const cost =
    totals.costMicro === 0
      ? `$${dollars} (unobserved — recorded $0.00, never estimated)`
      : `$${dollars} (recorded)`;
  return (
    `${totals.providerId}/${totals.modelId} calls=${totals.calls} ` +
    `in=${totals.inputTokens} out=${totals.outputTokens} cost=${cost}`
  );
}

/**
 * NOTE (host scope, not per-swarm): the usage ledger has no swarm key —
 * `listUsageTotals` returns host-recorded provider/model rollups across all
 * swarms on this host. Do NOT present these numbers as belonging to one
 * swarm; the `-- usage (recorded only) --` section header carries that scope.
 */
export function renderUsage(reader: BoardReader): string[] {
  const totals = reader.listUsageTotals();
  if (totals.length === 0) return ["usage: no recorded entries (unobserved — never estimated)"];
  return totals.map(renderUsageLine);
}

// --- Session-nav compat data ---

export interface SessionNavEntry {
  readonly sequence: number;
  readonly authorMemberId: string | null;
  readonly authorSessionId: string | null;
  readonly kind: PostKind;
}

/** Per-post session navigation data (member sessionId preserved verbatim). */
export function sessionNav(
  posts: readonly BoardPost[],
  members: readonly BoardMember[],
): SessionNavEntry[] {
  const sessionById = new Map(members.map((m) => [m.id, m.sessionId]));
  return posts.map((p) => ({
    sequence: p.sequence,
    authorMemberId: p.authorMemberId,
    authorSessionId: p.authorMemberId === null ? null : (sessionById.get(p.authorMemberId) ?? null),
    kind: p.kind,
  }));
}

// --- Follow / history / reconnect session ---

export interface UnreadDivider {
  readonly afterSequence: number;
}

/**
 * Cursor-based board session: chronological stream + live-follow + history
 * paging + unread divider + restart reconnect. Cursors are journal
 * `sequence` values (after-exclusive); reconnect replays from the last seen
 * sequence exactly — no assumed offsets.
 */
export class BoardSession {
  private lastSequence: number;
  private lastSeen: number;
  private follow: boolean;

  constructor(startAfter = 0, follow = true) {
    this.lastSequence = startAfter;
    this.lastSeen = startAfter;
    this.follow = follow;
  }

  get cursor(): number {
    return this.lastSequence;
  }

  get following(): boolean {
    return this.follow;
  }

  setFollow(on: boolean): void {
    this.follow = on;
  }

  markSeen(sequence: number): void {
    if (sequence > this.lastSeen) this.lastSeen = sequence;
  }

  divider(): UnreadDivider {
    return { afterSequence: this.lastSeen };
  }

  /** History page: posts after the session cursor; advances the cursor. */
  pageNext(reader: BoardReader, swarmId: string, limit = 100): BoardPost[] {
    const posts = reader.getPostsAfter(swarmId, this.lastSequence, limit);
    if (posts.length > 0) {
      const last = posts[posts.length - 1] as BoardPost;
      this.lastSequence = last.sequence;
    }
    return posts;
  }

  /**
   * Live-follow tick: when following, returns everything after the cursor
   * (same as pageNext); when paused for history review, returns [] so the
   * visible page never jumps.
   */
  liveTick(reader: BoardReader, swarmId: string, limit = 100): BoardPost[] {
    if (!this.follow) return [];
    return this.pageNext(reader, swarmId, limit);
  }

  /**
   * Reconnect after an OpenCode restart: replay missed posts and ADVANCE the
   * cursor to the last replayed sequence (one-shot per restart). Because the
   * cursor advances, a follow-up `pageNext`/`liveTick` continues WITHOUT
   * redelivering the replayed posts — reconnect→pageNext duplicates are
   * impossible. Crash replays therefore stay idempotent at the cursor level.
   */
  reconnect(reader: BoardReader, swarmId: string, limit = 100): BoardPost[] {
    const posts = reader.getPostsAfter(swarmId, this.lastSequence, limit);
    if (posts.length > 0) {
      const last = posts[posts.length - 1] as BoardPost;
      this.lastSequence = last.sequence;
    }
    return posts;
  }
}

// --- Full-board text render ---

export interface RenderOptions {
  readonly filter?: BoardFilter;
  readonly lastSeenSequence?: number;
  readonly deliveryWakes?: readonly BoardWake[];
  /**
   * Full wake set for task views (never state-prefiltered). Task
   * monitor-history is state-insensitive: a succeeded monitor wake must
   * still count even when the delivery section shows a queued-only subset.
   * Falls back to `deliveryWakes` when omitted (e.g. callers with no filter),
   * so existing callers without a prefilter keep working unchanged.
   */
  readonly taskWakes?: readonly BoardWake[];
  readonly showUsage?: boolean;
  /**
   * Live-follow indicator (D-07). `true` (default) renders `Live`;
   * `false` renders `Paused — N new` with `pausedNewCount`. Key handling
   * stays host-owned: the host passes its own follow state in.
   */
  readonly follow?: boolean;
  readonly pausedNewCount?: number;
  /** Verbose id/code lines for roster, delivery, and tasks (`--verbose`). */
  readonly verbose?: boolean;
}

/**
 * Render the whole terminal board as text lines. Pure function of reader
 * state — performs zero inference and never submits turns (it does not even
 * accept a harness parameter).
 */
export function renderBoard(reader: BoardReader, swarmId: string, options: RenderOptions = {}): string[] {
  const lines: string[] = [];
  const members = reader.listMembers(swarmId);
  const allPosts = reader.getPostsAfter(swarmId, 0, 1_000_000);
  const posts = options.filter === undefined ? allPosts : filterPosts(allPosts, members, options.filter);
  const verbose = options.verbose ?? false;

  lines.push(`== swarm ${swarmId} ==`);
  lines.push("-- roster --");
  const roster = buildRoster(reader, swarmId);
  if (roster.length === 0) {
    lines.push("No members yet");
  } else {
    for (const row of roster) {
      lines.push(renderRosterLine(row, verbose));
    }
  }
  const following = options.follow ?? true;
  const pausedCount = options.pausedNewCount ?? 0;
  lines.push(following ? "-- stream (Live) --" : `-- stream (Paused — ${pausedCount} new) --`);
  if (posts.length === 0) {
    lines.push("No posts yet");
  }
  const lastSeen = options.lastSeenSequence ?? 0;
  let dividerShown = false;
  for (const post of posts) {
    if (!dividerShown && lastSeen > 0 && post.sequence > lastSeen) {
      lines.push("── unread ──");
      dividerShown = true;
    }
    lines.push(renderPostLine(post, members, verbose));
  }
  if (options.deliveryWakes !== undefined) {
    lines.push("-- delivery --");
    const collapsed = collapseWakes(options.deliveryWakes);
    if (collapsed.length === 0) {
      lines.push("no wakes (unrelated posts wake nobody)");
    } else {
      for (const row of collapsed) lines.push(renderDeliveryLine(row, members, verbose));
    }
  }
  lines.push("-- tasks --");
  // Never state-prefiltered: task views need the FULL wake set (e.g. an
  // already-succeeded monitor wake) even when the delivery section above
  // renders a filtered subset. Callers with a delivery prefilter MUST pass
  // the unfiltered set as `taskWakes`.
  const taskWakes = options.taskWakes ?? options.deliveryWakes ?? [];
  const views = buildTaskViews(reader, swarmId, allPosts, taskWakes);
  if (views.length === 0) {
    lines.push("no tasks");
  } else {
    for (const view of views) lines.push(renderTaskLine(view, verbose));
  }
  if (options.showUsage === true) {
    lines.push("-- usage (recorded only, host scope) --");
    for (const line of renderUsage(reader)) lines.push(line);
  }
  return lines;
}

/**
 * Zero-inference attestation helper: asserts the given tracker recorded no
 * turn submissions across a board interaction. Tests hold the harness; the
 * board never sees it.
 */
export function assertZeroInference(tracker: TurnSubmitTracker): void {
  if (tracker.submits !== 0) {
    throw new Error(`zero-inference violated: ${tracker.submits} turn submission(s) recorded`);
  }
}
