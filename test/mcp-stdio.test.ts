/**
 * `genigrep mcp` as a real child process: the SDK's stdio client spawns it, lists the tools and calls
 * code_search against a fixture repository, with Jev replaced by a local fake server. Runs the source under
 * Bun, and the published build under Node once `bun run build` has produced dist/.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { findRipgrep } from "../src/ripgrep";
import { VERSION } from "../src/version";
import { fakeJevFetch, makeFixtureRepo, type FakeJevLog } from "./engine/helpers/fixture";

const root = join(import.meta.dir, "..");
const sourceCli = join(root, "src", "cli.ts");
const distCli = join(root, "dist", "cli.js");
const node = Bun.which("node");
const hasRipgrep = findRipgrep() !== null;

const KEY = "stdio-test-key-0000000001";
const log: FakeJevLog = { requests: [] };
const authHeaders: string[] = [];
let server: ReturnType<typeof Bun.serve> | null = null;
let repo = "";
let cfg = "";

beforeAll(() => {
  repo = makeFixtureRepo();
  cfg = mkdtempSync(join(tmpdir(), "genigrep-stdio-cfg-"));
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

async function session(command: string, args: string[]) {
  let stderr = "";
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: tmpdir(),
    env: {
      PATH: process.env.PATH ?? "",
      XDG_CONFIG_HOME: cfg,
      GENIGREP_JEV_API_KEY: KEY,
      GENIGREP_JEV_BASE_URL: `http://127.0.0.1:${server!.port}`,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "genigrep-stdio-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

const question = "How is the compaction token threshold computed and when does a turn compact?";
const keywords = ["compactionThresholdTokens", "compactNow", "contextWindow", "threshold"];

async function exercise(command: string, args: string[]) {
  const s = await session(command, [...args, "mcp", repo]);
  try {
    expect(s.client.getServerVersion()).toMatchObject({ name: "genigrep", version: VERSION });
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["code_search"]);
    const r = (await s.client.callTool({ name: "code_search", arguments: { question, keywords } })) as CallToolResult;
    expect(r.isError).toBe(false);
    const text = r.content[0]?.type === "text" ? r.content[0].text : "";
    expect(text.split("\n")[0]).toMatch(/^code_search: evidence rating /);
    expect(text).toContain("== src/compaction.ts:");
    expect(log.requests.length).toBeGreaterThan(0);
    expect(authHeaders.filter((h) => h).every((h) => h === `Bearer ${KEY}`)).toBe(true);
    expect(text).not.toContain(KEY);
  } finally {
    await s.client.close();
  }
  // The server logs to stderr only, and never the key.
  expect(s.stderr()).toContain("genigrep mcp ready");
  expect(s.stderr()).not.toContain(KEY);
}

(hasRipgrep ? describe : describe.skip)("genigrep mcp over stdio", () => {
  test("source under Bun", async () => {
    await exercise(process.execPath, [sourceCli]);
  }, 30_000);

  (existsSync(distCli) && node ? test : test.skip)("dist/cli.js under Node", async () => {
    await exercise(node!, [distCli]);
  }, 30_000);
});

describe("genigrep mcp startup", () => {
  test("a missing directory is a setup error before any protocol traffic", async () => {
    const proc = Bun.spawn([process.execPath, sourceCli, "mcp", join(tmpdir(), "genigrep-no-such-dir-51")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: cfg },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(3);
    expect(stdout).toBe("");
    expect(stderr).toContain("not a directory");
  });

  test("exits cleanly when the client closes stdin", async () => {
    const proc = Bun.spawn([process.execPath, sourceCli, "mcp", "-q", repo], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: cfg },
    });
    proc.stdin.end();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toBe("");
  });
});
