/**
 * M3 board service — chronological public board on top of the frozen M2 engine
 * (spec §14 M3; contracts C-PROTOCOL-01 / C-DB-01).
 *
 * Single public-post path: `SwarmStore.appendPost` is the ONLY sequence
 * allocator (ONE `BEGIN IMMEDIATE` bump of `swarms.revision` -> `sequence`;
 * never a second sequence, never MAX+1). Mention resolution (lexer +
 * snapshot resolver, `@member` / `@group` / `@all`, author excluded by
 * default, killed excluded) and the `post_recipients` write plus one wake
 * intent per live recipient (delivery_key idempotent, quota/killed never
 * admitted) all happen INSIDE that same store transaction — this service
 * deliberately performs NO second enqueue (a second batch with a different
 * payloadHash would mint a second delivery_key per recipient and break the
 * exactly-once-logical guarantee).
 *
 * Imports the store only; performs zero model inference and zero harness
 * submits (dispatch belongs to the M2 WakeDispatcher/daemon lane).
 */

import type { BoardPost, PostKind } from "@vuminkosi/protocol";
import type { SwarmStore } from "../db/store.js";

export interface PublicPostInput {
  readonly swarmId: string;
  readonly authorMemberId: string | null;
  readonly kind: PostKind;
  readonly body: string;
  readonly relatedTaskId?: string;
  readonly idempotencyKey: string;
}

export interface PublicPostResult {
  readonly post: BoardPost;
  /** True when the idempotencyKey replayed an existing post (no new row, no new wakes). */
  readonly deduped: boolean;
  /** Wake ids fanned out for this post (empty on dedupe or mention-free posts). */
  readonly wakeIds: readonly string[];
}

/**
 * Publish one public board post. Chronological order = `sequence` (durable,
 * gapless per swarm revision bump); readers page with `getPostsAfter`.
 */
export function publishPost(store: SwarmStore, input: PublicPostInput): PublicPostResult {
  return store.appendPost(input.swarmId, {
    authorMemberId: input.authorMemberId,
    kind: input.kind,
    body: input.body,
    ...(input.relatedTaskId === undefined ? {} : { relatedTaskId: input.relatedTaskId }),
    idempotencyKey: input.idempotencyKey,
  });
}

/** Chronological board history page (sequence ASC, after-exclusive cursor). */
export function readBoard(store: SwarmStore, swarmId: string, after = 0, limit = 100): BoardPost[] {
  return store.getPostsAfter(swarmId, after, limit);
}
