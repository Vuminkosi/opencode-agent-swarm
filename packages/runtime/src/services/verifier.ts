/**
 * M3 verifier — acceptance gate with defect fanout + remediation (spec §14
 * M3; contracts C-PROTOCOL-01 / C-DB-01).
 *
 * - Passing evidence (exit_code 0, real process proof recorded while the task
 *   is `verifying`) -> `verifying -> accepted`, gated by
 *   `assertVerifierAccept` (a worker can never accept its own task; the
 *   verifier must differ from the owner).
 * - Failing evidence -> the evidence row is still recorded (durable proof of
 *   the failure), a `verification` defect post mentioning the owner is
 *   published (store fanout mints the remediation wake: one logical intent
 *   per recipient + delivery_key), and the task returns `verifying -> ready`
 *   which bumps `attempt` (remediation attempt counter).
 * - Zero model inference; the wake dispatch itself stays in the M2 lane.
 */

import type { RecordEvidenceInput, Task } from "@opencode-swarm/protocol";
import type { SwarmStore } from "../db/store.js";

export interface EvidenceReport {
  readonly task: Task;
  /** Present only when failing evidence produced a defect post. */
  readonly defectPostId?: string;
  /** Present only when failing evidence fanned out remediation wakes. */
  readonly remediationWakeIds?: readonly string[];
}

function evidenceInput(input: {
  readonly taskId: string;
  readonly executorMemberId: string;
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly commitSha?: string;
  readonly stdoutSha256: string;
  readonly stdoutPath: string;
  readonly stderrSha256: string;
  readonly stderrPath: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}): RecordEvidenceInput {
  return {
    taskId: input.taskId,
    executorMemberId: input.executorMemberId,
    command: input.command,
    cwd: input.cwd,
    exitCode: input.exitCode,
    ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
    stdout: { sha256: input.stdoutSha256, filePath: input.stdoutPath },
    stderr: { sha256: input.stderrSha256, filePath: input.stderrPath },
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
}

/**
 * Record verification evidence and drive the gate.
 * - exitCode 0: record, then accept (`verifierMemberId` must differ from owner).
 * - exitCode != 0: record, post a defect mentioning the owner (mention fanout
 *   = remediation wake), then requeue to ready (attempt++).
 *
 * Crash-safety (S2-02): evidence and the state/post edge commit in separate
 * store txns, so a kill between commits leaves recorded evidence without its
 * edge. That is intentional append-only audit: a retry records one more
 * evidence row and takes exactly one state edge (same-state transitions are
 * store no-ops; the defect post collapses via `defectIdempotencyKey`), so a
 * kill-between-commits retry converges to a single accepted/ready edge.
 * A replay after a fully committed accept returns the accepted task without
 * recording duplicate evidence.
 */
export function submitVerification(
  store: SwarmStore,
  input: {
    readonly taskId: string;
    readonly executorMemberId: string;
    readonly verifierMemberId: string;
    readonly command: string;
    readonly cwd: string;
    readonly exitCode: number;
    readonly commitSha?: string;
    readonly stdoutSha256: string;
    readonly stdoutPath: string;
    readonly stderrSha256: string;
    readonly stderrPath: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly defectIdempotencyKey?: string;
  },
): EvidenceReport {
  const task = store.getTask(input.taskId);
  // S2-02 idempotent replay: a retry after a fully committed accept must not
  // append duplicate evidence — the gate already took its single edge.
  if (task.state === "accepted" && input.exitCode === 0) {
    return { task };
  }
  store.recordVerificationEvidence(evidenceInput(input));
  if (input.exitCode === 0) {
    const accepted = store.transitionTask(input.taskId, "accepted", {
      verifierMemberId: input.verifierMemberId,
    });
    return { task: accepted };
  }
  const owner = task.ownerId === null ? null : store.getMember(task.ownerId);
  const ownerName = owner?.name ?? "owner-unknown";
  const posted = store.appendPost(task.swarmId, {
    authorMemberId: input.verifierMemberId,
    kind: "verification",
    body:
      `@${ownerName} DEFECT task=${task.id} exit=${input.exitCode} cmd=${input.command}\n` +
      `Evidence recorded; fix and re-submit. Attempt ${task.attempt + 1}.`,
    relatedTaskId: task.id,
    idempotencyKey:
      input.defectIdempotencyKey ?? `m3-defect-${task.id}-attempt-${task.attempt + 1}`,
  });
  const requeued = store.transitionTask(input.taskId, "ready");
  return { task: requeued, defectPostId: posted.post.id, remediationWakeIds: posted.wakeIds };
}
