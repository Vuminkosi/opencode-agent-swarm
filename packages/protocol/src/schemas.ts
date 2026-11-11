/**
 * Zod-single-source protocol schemas — M1-01 (contract C-PROTOCOL-01).
 *
 * Rule: these Zod schemas are the ONLY definition of the wire/domain
 * shapes below. TypeScript types are derived via `z.infer`. Do not
 * hand-duplicate the same shapes as interfaces elsewhere.
 *
 * Covers spec §5: Swarm, Member, Task, BoardPost, WakeIntent,
 * VerificationEvidence + envelope (schemaVersion / correlationId /
 * idempotency) and daemon input schemas.
 *
 * Evidence: [DESIGN] (spec §5).
 */
import { z } from "zod";
import { SCHEMA_VERSION } from "./version.js";

const idString = z.string().min(1).max(128);
const nameString = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "name must match [A-Za-z0-9_-]+");
const isoDateTime = z.string().datetime({ offset: true });
const nullableId = z.string().min(1).max(128).nullable();

// --- Enums (mirror DB CHECK constraints in migration 001) ---

export const MemberRoleSchema = z.enum(["coordinator", "coder", "verifier", "monitor", "researcher"]);
export type MemberRole = z.infer<typeof MemberRoleSchema>;

export const PublicMemberStateSchema = z.enum(["working", "waiting", "killed"]);
export type PublicMemberState = z.infer<typeof PublicMemberStateSchema>;

export const InternalMemberStateSchema = z.enum([
  "starting",
  "working",
  "waiting",
  "quota_paused",
  "approval_paused",
  "recovering",
  "killed",
]);
export type InternalMemberState = z.infer<typeof InternalMemberStateSchema>;

export const TaskStateSchema = z.enum([
  "draft",
  "ready",
  "leased",
  "running",
  "verifying",
  "blocked",
  "accepted",
  "failed",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const PostKindSchema = z.enum([
  "brief",
  "message",
  "question",
  "progress",
  "result",
  "verification",
  "monitor",
  "done",
  "system",
]);
export type PostKind = z.infer<typeof PostKindSchema>;

export const WakeReasonSchema = z.enum([
  "mention",
  "assigned_task",
  "verifier_request",
  "monitor_intervention",
  "user_direct",
]);
export type WakeReason = z.infer<typeof WakeReasonSchema>;

export const WakeStateSchema = z.enum([
  "queued",
  "admitted",
  "observed_running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type WakeState = z.infer<typeof WakeStateSchema>;

export const SwarmModeSchema = z.enum(["parity", "safe-coding"]);
export type SwarmMode = z.infer<typeof SwarmModeSchema>;

export const SwarmStatusSchema = z.enum([
  "planning",
  "running",
  "paused",
  "completing",
  "completed",
  "failed",
  "cancelled",
]);
export type SwarmStatus = z.infer<typeof SwarmStatusSchema>;

// --- Entities ---

export const ModelRefSchema = z.object({
  providerID: z.string().min(1),
  id: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const SwarmSchema = z.object({
  id: idString,
  title: z.string().min(1).max(256),
  coordinatorSessionId: z.string().min(1),
  projectRoot: z.string().min(1),
  mode: SwarmModeSchema,
  status: SwarmStatusSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  revision: z.number().int().nonnegative(),
});
export type Swarm = z.infer<typeof SwarmSchema>;

export const MemberSchema = z.object({
  id: idString,
  swarmId: idString,
  name: nameString,
  groups: z.array(z.string().min(1).max(64)).default([]),
  role: MemberRoleSchema,
  nativeAgentId: z.string().min(1),
  sessionId: z.string().min(1),
  model: ModelRefSchema,
  publicState: PublicMemberStateSchema,
  internalState: InternalMemberStateSchema,
  generation: z.number().int().positive(),
  lastActivityAt: isoDateTime,
  killedAt: isoDateTime.nullable(),
});
export type Member = z.infer<typeof MemberSchema>;

export const TaskSchema = z.object({
  id: idString,
  swarmId: idString,
  title: z.string().min(1).max(256),
  brief: z.string().min(1).max(65536),
  ownerId: nullableId,
  deps: z.array(idString).default([]),
  ownedPaths: z.array(z.string().min(1)).default([]),
  forbiddenPaths: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  state: TaskStateSchema,
  attempt: z.number().int().nonnegative(),
  generation: z.number().int().positive(),
  worktreePath: z.string().min(1).nullable(),
  baseCommit: z.string().min(1).nullable(),
  resultEvidenceIds: z.array(idString).default([]),
});
export type Task = z.infer<typeof TaskSchema>;

export const BoardPostSchema = z.object({
  id: idString,
  swarmId: idString,
  sequence: z.number().int().positive(),
  authorMemberId: nullableId,
  kind: PostKindSchema,
  body: z.string().min(1).max(131072),
  mentions: z.array(idString).default([]),
  groupMentions: z.array(z.string().min(1)).default([]),
  mentionAll: z.boolean().default(false),
  createdAt: isoDateTime,
  idempotencyKey: z.string().min(1).max(256),
  relatedTaskId: nullableId,
});
export type BoardPost = z.infer<typeof BoardPostSchema>;

export const WakeIntentSchema = z.object({
  id: idString,
  swarmId: idString,
  memberId: idString,
  memberGeneration: z.number().int().positive(),
  reason: WakeReasonSchema,
  postSequence: z.number().int().positive().nullable(),
  taskId: nullableId,
  payloadHash: z.string().min(1),
  state: WakeStateSchema,
  attempts: z.number().int().nonnegative(),
  createdAt: isoDateTime,
});
export type WakeIntent = z.infer<typeof WakeIntentSchema>;

export const VerificationEvidenceSchema = z.object({
  id: idString,
  taskId: idString,
  commitSha: z.string().min(1).nullable(),
  command: z.string().min(1),
  cwd: z.string().min(1),
  exitCode: z.number().int(),
  startedAt: isoDateTime,
  finishedAt: isoDateTime,
  stdoutArtifactId: idString,
  stderrArtifactId: idString,
  executorMemberId: idString,
});
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;

// --- Wire envelope (spec §5: schemaVersion + correlationId + idempotency) ---

export const EnvelopeSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  swarmId: idString,
  correlationId: z.string().uuid(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export function makeEnvelope(swarmId: string, correlationId?: string): Envelope {
  return EnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    swarmId,
    correlationId: correlationId ?? crypto.randomUUID(),
  });
}

// --- Daemon input schemas (validated at the M1-02 transport boundary) ---

export const CreateSwarmInputSchema = z.object({
  title: z.string().min(1).max(256),
  coordinatorSessionId: z.string().min(1),
  projectRoot: z.string().min(1),
  mode: SwarmModeSchema,
});
export type CreateSwarmInput = z.input<typeof CreateSwarmInputSchema>;

export const AddMemberInputSchema = z.object({
  name: nameString,
  groups: z.array(z.string().min(1).max(64)).default([]),
  role: MemberRoleSchema,
  nativeAgentId: z.string().min(1),
  sessionId: z.string().min(1),
  model: ModelRefSchema,
});
export type AddMemberInput = z.input<typeof AddMemberInputSchema>;

export const CreateTaskInputSchema = z.object({
  title: z.string().min(1).max(256),
  brief: z.string().min(1).max(65536),
  ownerId: z.string().min(1).max(128).optional(),
  deps: z.array(idString).default([]),
  ownedPaths: z.array(z.string().min(1)).default([]),
  forbiddenPaths: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
});
export type CreateTaskInput = z.input<typeof CreateTaskInputSchema>;

export const AppendPostInputSchema = z.object({
  authorMemberId: z.string().min(1).max(128).nullable(),
  kind: PostKindSchema,
  body: z.string().min(1).max(131072),
  relatedTaskId: z.string().min(1).max(128).optional(),
  idempotencyKey: z.string().min(1).max(256),
});
export type AppendPostInput = z.input<typeof AppendPostInputSchema>;

export const CreateWakeIntentInputSchema = z.object({
  memberId: idString,
  memberGeneration: z.number().int().positive(),
  reason: WakeReasonSchema,
  postSequence: z.number().int().positive().optional(),
  taskId: idString.optional(),
  payloadHash: z.string().min(1).max(256),
});
export type CreateWakeIntentInput = z.input<typeof CreateWakeIntentInputSchema>;

export const RecordEvidenceInputSchema = z.object({
  taskId: idString,
  executorMemberId: idString,
  command: z.string().min(1).max(4096),
  cwd: z.string().min(1).max(4096),
  exitCode: z.number().int(),
  commitSha: z.string().min(1).max(128).optional(),
  startedAt: isoDateTime,
  finishedAt: isoDateTime,
  stdout: z.object({ sha256: z.string().min(1), filePath: z.string().min(1) }),
  stderr: z.object({ sha256: z.string().min(1), filePath: z.string().min(1) }),
});
export type RecordEvidenceInput = z.input<typeof RecordEvidenceInputSchema>;
