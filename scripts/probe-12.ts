/**
 * Probe 12 — plugin process exit/reload while daemon continues running.
 * Spec §4.6(12). M0-01 scope: prove the probe daemon-stub survives plugin
 * teardown; full daemon arrives in M1-02. Uses loopback only.
 */
import { log, verdict, tryRun } from "./probe-lib.ts";

const N = "12";
log(N, "steps: start stub daemon (bun) -> load/unload probe plugin -> assert stub still serves /healthz");

const stub = await tryRun("bun", ["--version"]);
log(N, `bun: ${stub?.out.trim() ?? "UNAVAILABLE"}`);
verdict(
  N,
  "NOT VERIFIED",
  "stub-daemon survival test not yet executed — implement stub in M1-02, rerun; daemon-owns-durability invariant depends on it",
);
