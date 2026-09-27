/**
 * The MCP server driven by the SDK's own client over an in-memory transport, against a fixture repository
 * and a fake Jev. No API key or network is needed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CODE_SEARCH_DIRECTIVE, CODE_SEARCH_TOOL_DESCRIPTION, JevCircuitBreaker } from "../src/engine";
import {
  MCP_TOOL_DESCRIPTION,
  createGenigrepMcpServer,
  type GenigrepMcpServerOptions,
} from "../src/mcp/server";
import { findRipgrep } from "../src/ripgrep";
import { VERSION } from "../src/version";
import { FIXTURE_FILES, fakeJevFetch, makeFixtureRepo, type FakeJevLog, type FakeJevOptions } from "./engine/helpers/fixture";

const describeWithRipgrep = findRipgrep() ? describe : describe.skip;
const KEY = "mcp-test-key-do-not-print-4242";
const SECRET = "SECRET_VALUE_mcp_91c2";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const repo = makeFixtureRepo({
  ...FIXTURE_FILES,
  ".env": `COMPACTION_TOKEN=${SECRET}\ncompactionThresholdTokens=${SECRET}\n`,
});
dirs.push(repo);
const elsewhere = temp("genigrep-mcp-elsewhere-");
writeFileSync(join(elsewhere, "other.ts"), "export const compactionThresholdTokens = 1;\n");

const question = "How is the compaction token threshold computed and when does a turn compact?";
const keywords = ["compactionThresholdTokens", "compactNow", "contextWindow", "threshold"];

interface Session {
  client: Client;
  log: FakeJevLog;
  logs: string[];
  call: (args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  /** Changes the roots the client reports (with the roots capability). */
  setRoots: (next: string[]) => void;
  close: () => Promise<void>;
}

async function connect(
  options: {
    server?: GenigrepMcpServerOptions;
    jev?: FakeJevOptions;
    withKey?: boolean;
    roots?: string[];
  } = {},
): Promise<Session> {
  const log: FakeJevLog = { requests: [] };
  const logs: string[] = [];
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: temp("genigrep-mcp-cfg-"),
    PATH: process.env.PATH,
    ...(options.withKey === false ? {} : { GENIGREP_JEV_API_KEY: KEY }),
  };
  const server = createGenigrepMcpServer({
    env,
    cwd: repo,
    log: (line) => logs.push(line),
    fetch: fakeJevFetch({ ...options.jev, log }),
    ...options.server,
  });
  const client = new Client(
    { name: "genigrep-test", version: "0.0.0" },
    { capabilities: options.roots ? { roots: { listChanged: true } } : {} },
  );
  let roots = options.roots;
  if (roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: (roots ?? []).map((r) => ({ uri: pathToFileURL(r).href })),
    }));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    log,
    logs,
    call: async (args) => {
      const r = (await client.callTool({ name: "code_search", arguments: args })) as CallToolResult;
      const first = r.content[0];
      return { text: first?.type === "text" ? first.text : "", isError: r.isError === true };
    },
    setRoots: (next) => {
      roots = next;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("genigrep mcp: tool surface", () => {
  test("advertises one read-only code_search tool with OpenGeni's wording and instructions", async () => {
    const s = await connect();
    try {
      expect(s.client.getServerVersion()).toMatchObject({ name: "genigrep", version: VERSION });
      expect(s.client.getInstructions()).toBe(CODE_SEARCH_DIRECTIVE);
      const { tools } = await s.client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["code_search"]);
      const tool = tools[0]!;
      expect(tool.description).toBe(MCP_TOOL_DESCRIPTION);
      // The shipped wording from "It ranks files" to the end is kept verbatim.
      const shippedTail = CODE_SEARCH_TOOL_DESCRIPTION.slice(CODE_SEARCH_TOOL_DESCRIPTION.indexOf("It ranks files"));
      expect(shippedTail).toContain("The rating cannot see what the search missed");
      expect(tool.description!.endsWith(shippedTail)).toBe(true);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      expect(tool.inputSchema.required).toEqual(["question", "keywords"]);
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(
        ["directory", "keywords", "paths", "question", "subQuestions"],
      );
      expect(tool.inputSchema.additionalProperties).toBe(false);
    } finally {
      await s.close();
    }
  });

  test("an unknown tool is a protocol error", async () => {
    const s = await connect();
    try {
      await expect(s.client.callTool({ name: "nope", arguments: {} })).rejects.toThrow(/Unknown tool/);
    } finally {
      await s.close();
    }
  });
});

describeWithRipgrep("genigrep mcp: code_search", () => {
  test("returns the evidence pack for the project directory", async () => {
    const s = await connect();
    try {
      const r = await s.call({ question, keywords, subQuestions: ["When does a turn compact?"] });
      expect(r.isError).toBe(false);
      expect(r.text.split("\n")[0]).toMatch(/^code_search: evidence rating 0\.\d\d \(s1 0\.\d\d\) \| \d+ passages from \d+ files/);
      expect(r.text).toContain("== src/compaction.ts:");
      expect(r.text).toMatch(/\n\d+\| export function compactionThresholdTokens/);
      expect(r.text).toMatch(/\nPaths are relative to .+code-search-fixture-[^\n]+\.$/);
      expect(s.log.requests.length).toBeGreaterThan(0);
      expect(s.logs.some((l) => /^genigrep mcp: code_search \d+ passages \| .* \| jev \d+ requests/.test(l))).toBe(true);
      expect(s.logs.join("\n")).not.toContain(KEY);
    } finally {
      await s.close();
    }
  });

  test("secret files never reach Jev", async () => {
    const s = await connect();
    try {
      const r = await s.call({ question, keywords: [...keywords, "COMPACTION_TOKEN"] });
      expect(r.isError).toBe(false);
      for (const req of s.log.requests) expect(JSON.stringify(req)).not.toContain(SECRET);
      expect(r.text).not.toContain(SECRET);
    } finally {
      await s.close();
    }
  });

  test("paths focus the search and directory picks a subdirectory", async () => {
    const s = await connect();
    try {
      const focused = await s.call({ question, keywords, paths: ["src"] });
      expect(focused.isError).toBe(false);
      expect(focused.text).toContain("== src/compaction.ts:");
      const sub = await s.call({ question, keywords, directory: "src" });
      expect(sub.isError).toBe(false);
      expect(sub.text).toContain("== compaction.ts:");
      expect(sub.text).toMatch(/Paths are relative to .+\/src\.$/);
    } finally {
      await s.close();
    }
  });

  test("invalid arguments come back as tool errors without calling Jev", async () => {
    const s = await connect();
    try {
      const missing = await s.call({ question });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain("code_search: invalid arguments: keywords is required");
      const unknown = await s.call({ question, keywords, budget: 5 });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain('unknown argument "budget"');
      expect(unknown.text).toContain("allowed: question, keywords, subQuestions, paths, directory");
      const absolute = await s.call({ question, keywords, paths: ["/etc"] });
      expect(absolute.isError).toBe(true);
      expect(absolute.text).toContain("is absolute");
      expect(s.log.requests.length).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("directory must stay inside the project roots", async () => {
    const s = await connect();
    try {
      const outside = await s.call({ question, keywords, directory: elsewhere });
      expect(outside.isError).toBe(true);
      expect(outside.text).toContain("outside the project directories");
      const up = await s.call({ question, keywords, directory: ".." });
      expect(up.isError).toBe(true);
      expect(up.text).toContain("outside the project directories");
      const missing = await s.call({ question, keywords, directory: "no-such-dir" });
      expect(missing.text).toContain("does not exist");
      const file = await s.call({ question, keywords, directory: "src/turn.ts" });
      expect(file.isError).toBe(true);
      expect(file.text).toContain("is a file");
      expect(s.log.requests.length).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("directories given to the server replace the working directory", async () => {
    const s = await connect({ server: { directories: [elsewhere], cwd: repo } });
    try {
      const r = await s.call({ question, keywords });
      expect(r.isError).toBe(false);
      expect(r.text).toContain("== other.ts:");
      const back = await s.call({ question, keywords, directory: repo });
      expect(back.text).toContain("outside the project directories");
    } finally {
      await s.close();
    }
  });

  test("uses the client's roots and follows roots/list_changed", async () => {
    const s = await connect({ roots: [elsewhere], server: { cwd: tmpdir() } });
    try {
      const first = await s.call({ question, keywords });
      expect(first.isError).toBe(false);
      expect(first.text).toContain("== other.ts:");
      s.setRoots([repo]);
      await s.client.sendRootsListChanged();
      await Bun.sleep(20);
      const second = await s.call({ question, keywords });
      expect(second.text).toContain("== src/compaction.ts:");
    } finally {
      await s.close();
    }
  });

  test("a client whose roots/list fails falls back to the working directory, asking once", async () => {
    const s = await connect({ roots: [] });
    let asked = 0;
    s.client.setRequestHandler(ListRootsRequestSchema, async () => {
      asked++;
      throw new Error("roots unavailable");
    });
    try {
      for (let i = 0; i < 2; i++) {
        const r = await s.call({ question, keywords });
        expect(r.isError).toBe(false);
        expect(r.text).toContain("== src/compaction.ts:");
      }
      expect(asked).toBe(1);
      expect(s.logs.some((l) => l.includes("could not list the client's roots"))).toBe(true);
    } finally {
      await s.close();
    }
  });

  test("refuses to guess when it was started in the home directory without roots", async () => {
    const home = temp("genigrep-mcp-home-");
    const project = join(home, "project");
    mkdirSync(project);
    writeFileSync(join(project, "a.ts"), "export const compactionThresholdTokens = 2;\n");
    const s = await connect({ server: { cwd: home, home } });
    try {
      const r = await s.call({ question, keywords });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("does not know which project to search");
      const explicit = await s.call({ question, keywords, directory: project });
      expect(explicit.isError).toBe(false);
      expect(explicit.text).toContain("== a.ts:");
    } finally {
      await s.close();
    }
  });

  test("refuses a credentials directory", async () => {
    const home = temp("genigrep-mcp-home-");
    const aws = join(home, ".aws");
    mkdirSync(aws);
    writeFileSync(join(aws, "credentials"), `aws_secret_access_key = ${SECRET}\n`);
    const s = await connect({ server: { cwd: home, home } });
    try {
      const r = await s.call({ question, keywords: ["aws_secret_access_key"], directory: ".aws" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("credentials directory");
      expect(s.log.requests.length).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("without an API key the agent is told how to fix it and to use rg", async () => {
    const s = await connect({ withKey: false });
    try {
      const r = await s.call({ question, keywords });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("genigrep auth");
      expect(r.text).toContain("Search with rg, grep or file reads instead.");
      expect(s.log.requests.length).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("a rejected key says so and never echoes the key", async () => {
    const s = await connect({ jev: { rejectStatus: 401 } });
    try {
      const r = await s.call({ question, keywords });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Jev rejected the API key (HTTP 401)");
      expect(r.text).not.toContain(KEY);
      expect(s.logs.join("\n")).not.toContain(KEY);
    } finally {
      await s.close();
    }
  });

  test("the circuit breaker refuses calls at once after repeated Jev outages", async () => {
    const breaker = new JevCircuitBreaker({ failureThreshold: 2 });
    const s = await connect({ jev: { fail: true }, server: { breaker } });
    try {
      for (let i = 0; i < 2; i++) {
        const r = await s.call({ question, keywords });
        expect(r.isError).toBe(true);
        expect(r.text).toContain("code_search is unavailable right now");
      }
      const before = s.log.requests.length;
      const refused = await s.call({ question, keywords });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("calls are paused");
      expect(s.log.requests.length).toBe(before);
    } finally {
      await s.close();
    }
  }, 60_000);
});
