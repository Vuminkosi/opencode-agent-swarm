/**
 * Minimal ambient runtime surface for swarmctl (M1-02).
 *
 * apps/swarmctl is intentionally NOT a package workspace, so it cannot
 * resolve bun-types/@types/node globals. status.ts only needs this tiny
 * surface; `fetch`, `setTimeout`, and console come from lib DOM+ES2022.
 * Bun and Node both provide this shape at runtime.
 */
declare const process: {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  exit(code: number): never;
};

interface ImportMeta {
  readonly main: boolean;
}
