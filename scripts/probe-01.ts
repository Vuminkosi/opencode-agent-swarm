/**
 * Probe 01 — clean pinned OpenCode 2.x install + no-op server plugin compile.
 * Spec §4.6(1). Evidence: disposable-dir package versions + tsc exit code.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { probeDir, log, verdict, tryRun } from "./probe-lib.ts";

const N = "01";
const dir = join(probeDir(), "probe-01");
mkdirSync(dir, { recursive: true });
log(N, `probe dir: ${dir}`);

const bun = await tryRun("bun", ["--version"]);
log(N, `bun: ${bun?.out.trim() ?? "UNAVAILABLE"}`);
const oc = await tryRun("opencode", ["--version"]);
log(N, `opencode: ${oc?.out.trim() ?? "UNAVAILABLE"}`);
if (bun === null) {
  verdict(N, "NOT VERIFIED", "bun not on PATH in this environment");
  process.exit(0);
}

// Resolve the @opencode/plugin version compatible with the pinned CLI.
// Do NOT mix generations: @opencode/* (v2) only, never @opencode-ai/*.
const meta = await tryRun("bun", ["pm", "view", "@opencode/plugin", "versions", "--json"], dir);
log(N, `@opencode/plugin registry metadata: ${(meta?.out ?? "UNAVAILABLE").slice(0, 500)}`);

const pkg = {
  name: "probe-01-noop-plugin",
  version: "0.0.1",
  private: true,
  type: "module",
  dependencies: { "@opencode/plugin": "TBD-BY-PROBE-01" },
  devDependencies: { typescript: "5.9.2" },
};
writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
writeFileSync(
  join(dir, "index.ts"),
  `// No-op server plugin per spec §4.1 [OC2-DOC] — compile check only.\nimport { Plugin } from "@opencode/plugin";\nexport default Plugin.define({\n  id: "swarm-probe-01",\n  async setup(_ctx) {\n    return async () => {};\n  },\n});\n`,
);
log(N, "wrote package.json + index.ts skeletons (fill @opencode/plugin pin from registry metadata above)");

if (!existsSync(join(dir, "node_modules", "@opencode", "plugin"))) {
  verdict(
    N,
    "NOT VERIFIED",
    "requires `bun install` in disposable dir + registry access; then `tsc --noEmit index.ts`",
  );
  process.exit(0);
}
const tsc = await tryRun("bunx", ["--bun", "tsc", "--noEmit", "--strict", "index.ts"], dir);
log(N, `tsc exit=${tsc?.code} out=${(tsc?.out ?? "").slice(0, 1000)}`);
if (tsc?.code === 0) verdict(N, "PASS", "no-op server plugin compiles against pinned @opencode/plugin");
else verdict(N, "FAIL", "no-op server plugin failed to compile — see log; fallback: record gap, block M0-02");
