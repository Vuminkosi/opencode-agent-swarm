/**
 * In-process SSE fan-out hub — M1-02.
 *
 * Single-daemon-process publish/subscribe keyed by swarm id. The board
 * journal (SQLite) is the durability layer; this hub only wakes live SSE
 * connections. Reconnecting clients always replay from
 * `store.getPostsAfter(swarmId, after)` first, so a missed broadcast can
 * never lose a committed post (spec §12: replay from our board sequences,
 * not volatile stream offsets).
 */
import type { BoardPost } from "@opencode-swarm/protocol";

export type PostListener = (post: BoardPost) => void;

export class BroadcastHub {
  private readonly listeners = new Map<string, Set<PostListener>>();

  subscribe(swarmId: string, listener: PostListener): () => void {
    let set = this.listeners.get(swarmId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(swarmId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(swarmId);
      if (current !== undefined) {
        current.delete(listener);
        if (current.size === 0) this.listeners.delete(swarmId);
      }
    };
  }

  publish(swarmId: string, post: BoardPost): void {
    const set = this.listeners.get(swarmId);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        listener(post);
      } catch {
        /* a slow/broken listener must not break the publish path */
      }
    }
  }

  listenerCount(swarmId: string): number {
    return this.listeners.get(swarmId)?.size ?? 0;
  }
}
