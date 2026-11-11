/**
 * M1-02 daemon config tests (F4 remediation).
 *
 * Covers: defaults, bearer-token floor (file + env), non-loopback
 * refusal, isLoopbackHost edge cases (incl. 0.0.0.0 is NOT loopback),
 * and ephemeral-port (port 0) daemon survival.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoopbackHost, parseDaemonConfig } from "./config.js";
import { startDaemon } from "./server.js";

const TOKEN = "config-test-bearer-token-0123456789";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env["SWARM_DAEMON_TOKEN"];
  delete process.env["SWARM_DAEMON_TOKEN"];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env["SWARM_DAEMON_TOKEN"];
  else process.env["SWARM_DAEMON_TOKEN"] = savedEnv;
});

function minimalRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runtime: { databasePath: join(tmpdir(), "cfg-test.sqlite") },
    ...overrides,
  };
}

describe("daemon config defaults", () => {
  test("loopback bind + port 4788 + parity mode by default", () => {
    const cfg = parseDaemonConfig({
      schemaVersion: 1,
      runtime: { databasePath: "/tmp/x.sqlite" },
      auth: { token: TOKEN },
    });
    expect(cfg.listen).toBe("127.0.0.1");
    expect(cfg.port).toBe(4788);
    expect(cfg.mode).toBe("parity");
    expect(cfg.token).toBe(TOKEN);
    expect(cfg.databasePath).toBe("/tmp/x.sqlite");
  });
});

describe("bearer token floor", () => {
  test("file token (min 16 chars) is accepted", () => {
    const cfg = parseDaemonConfig(minimalRaw({ auth: { token: "1234567890123456" } }));
    expect(cfg.token).toBe("1234567890123456");
  });

  test("env token is accepted when the file has none", () => {
    process.env["SWARM_DAEMON_TOKEN"] = TOKEN;
    const cfg = parseDaemonConfig(minimalRaw());
    expect(cfg.token).toBe(TOKEN);
  });

  test("missing token is refused", () => {
    expect(() => parseDaemonConfig(minimalRaw())).toThrow(/bearer token/i);
  });

  test("short token is refused (file and env)", () => {
    expect(() => parseDaemonConfig(minimalRaw({ auth: { token: "too-short" } }))).toThrow(/16/);
    process.env["SWARM_DAEMON_TOKEN"] = "short";
    expect(() => parseDaemonConfig(minimalRaw())).toThrow(/min 16/i);
  });
});

describe("non-loopback refusal", () => {
  test("non-loopback listen without a file token is refused", () => {
    expect(() =>
      parseDaemonConfig({
        schemaVersion: 1,
        runtime: { listen: "0.0.0.0", port: 4788, databasePath: "/tmp/x.sqlite" },
      }),
    ).toThrow(/non-loopback/i);
  });

  test("non-loopback listen with an explicit file token starts", () => {
    const cfg = parseDaemonConfig({
      schemaVersion: 1,
      runtime: { listen: "0.0.0.0", port: 4788, databasePath: "/tmp/x.sqlite" },
      auth: { token: TOKEN },
    });
    expect(cfg.listen).toBe("0.0.0.0");
  });
});

describe("isLoopbackHost edges", () => {
  test.each([
    ["127.0.0.1", true],
    ["127.0.0.5", true],
    ["127.255.255.255", true],
    ["localhost", true],
    ["::1", true],
    ["[::1]", true],
    ["0.0.0.0", false],
    ["192.168.1.1", false],
    ["10.0.0.1", false],
    ["128.0.0.1", false],
    ["127.999.1.1", false],
    ["127.0.0", false],
    ["", false],
    ["evil.example.com", false],
  ])("%s → %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe("ephemeral-port survival", () => {
  test("daemon binds port 0, serves healthz + writes, and closes cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-eph-"));
    const cfg = parseDaemonConfig({
      schemaVersion: 1,
      runtime: { listen: "127.0.0.1", port: 0, databasePath: join(dir, "eph.sqlite") },
      auth: { token: TOKEN },
    });
    const daemon = startDaemon({ config: cfg, onLog: () => {} });
    try {
      expect(daemon.port).toBeGreaterThan(0);
      const health = await fetch(`${daemon.url}/healthz`);
      expect(health.status).toBe(200);
      const created = await fetch(`${daemon.url}/v1/swarms`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          title: "ephemeral",
          coordinatorSessionId: "s",
          projectRoot: "/tmp/eph",
          mode: "parity",
        }),
      });
      expect(created.status).toBe(201);
    } finally {
      daemon.close();
    }
  });
});
