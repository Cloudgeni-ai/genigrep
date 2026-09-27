/**
 * The published build under Node: dist/cli.js searches a fixture repository against a local fake Jev
 * server. Skipped until `bun run build` has produced dist/.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRipgrep } from "../src/ripgrep";
import { fakeJevFetch, makeFixtureRepo, type FakeJevLog } from "./engine/helpers/fixture";

const cli = join(import.meta.dir, "..", "dist", "cli.js");
const node = Bun.which("node");
const ready = existsSync(cli) && node !== null && findRipgrep() !== null;
const describeBuilt = ready ? describe : describe.skip;

const KEY = "dist-test-key-0000000001";
const log: FakeJevLog = { requests: [] };
const authHeaders: string[] = [];
let server: ReturnType<typeof Bun.serve> | null = null;
let repo = "";
let cfg = "";

beforeAll(() => {
  if (!ready) return;
  repo = makeFixtureRepo();
  cfg = mkdtempSync(join(tmpdir(), "genigrep-dist-cfg-"));
  const fake = fakeJevFetch({ log });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      authHeaders.push(req.headers.get("authorization") ?? "");
      return await fake(req.url, { method: req.method, body: req.method === "POST" ? await req.text() : null });
    },
  });
});

afterAll(() => {
  server?.stop(true);
  if (repo) rmSync(repo, { recursive: true, force: true });
  if (cfg) rmSync(cfg, { recursive: true, force: true });
});

async function runNode(args: string[]) {
  const proc = Bun.spawn([node!, cli, ...args], {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? "",
      XDG_CONFIG_HOME: cfg,
      GENIGREP_JEV_API_KEY: KEY,
      GENIGREP_JEV_BASE_URL: `http://127.0.0.1:${server!.port}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describeBuilt("dist/cli.js under Node", () => {
  test("--version", async () => {
    const r = await runNode(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^genigrep \d+\.\d+\.\d+/);
  });

  test("searches a repository end to end", async () => {
    const r = await runNode([
      "How is the compaction token threshold computed and when does a turn compact?",
      "-k",
      "compactionThresholdTokens,compactNow,contextWindow,threshold",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toMatch(/^genigrep: evidence rating /);
    expect(r.stdout).toContain("== src/compaction.ts:");
    expect(r.stderr).toMatch(/jev \d+ requests/);
    expect(log.requests.length).toBeGreaterThan(0);
    expect(authHeaders.filter((h) => h).every((h) => h === `Bearer ${KEY}`)).toBe(true);
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });
});
