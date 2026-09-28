/** The CLI driven in-process against a fixture repository and a fake Jev. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../src/cli/args";
import { main, type CliIo } from "../src/cli/main";
import { findRipgrep } from "../src/ripgrep";
import { FIXTURE_FILES, fakeJevFetch, makeFixtureRepo, type FakeJevLog, type FakeJevOptions } from "./engine/helpers/fixture";

const describeWithRipgrep = findRipgrep() ? describe : describe.skip;
const KEY = "test-key-do-not-print-4242";
const SECRET = "SECRET_VALUE_7f3a9";

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
  "config/secrets.yml": `compactNow: ${SECRET}\n`,
});
dirs.push(repo);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  log: FakeJevLog;
}

async function run(
  argv: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    jev?: FakeJevOptions;
    secret?: string | null;
    signal?: AbortSignal;
    withKey?: boolean;
  } = {},
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const log: FakeJevLog = { requests: [] };
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: temp("genigrep-cli-cfg-"),
    PATH: process.env.PATH,
    ...(options.withKey === false ? {} : { GENIGREP_JEV_API_KEY: KEY }),
    ...options.env,
  };
  const io: CliIo = {
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    env,
    cwd: repo,
    signal: options.signal,
    readSecret: async () => options.secret ?? null,
    fetch: fakeJevFetch({ ...options.jev, log }),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, log };
}

const question = "How is the compaction token threshold computed and when does a turn compact?";
const kw = ["-k", "compactionThresholdTokens,compactNow,contextWindow,threshold"];

describeWithRipgrep("genigrep search", () => {
  test("prints the evidence pack on stdout and a summary on stderr", async () => {
    const r = await run([question, ".", ...kw]);
    expect(r.code).toBe(EXIT.OK);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(/^genigrep: evidence rating 0\.\d\d \| \d+ passages from \d+ files/);
    expect(r.stdout).toContain("== src/compaction.ts:");
    expect(r.stdout).toMatch(/\n\d+\| export function compactionThresholdTokens/);
    expect(r.stderr).toMatch(/^genigrep: \d+ passages from \d+ files, ~[\d.k]+ tokens \| \d+\.\ds \| jev \d+ requests, [\d.k]+ input tokens, \$\d/m);
    expect(r.stderr.trim().split("\n").length).toBe(1);
  });

  test("secret files never reach Jev, even when named explicitly", async () => {
    const r = await run([question, ".", ...kw, "-k", "COMPACTION_TOKEN"]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.log.requests.length).toBeGreaterThan(0);
    for (const req of r.log.requests) expect(JSON.stringify(req)).not.toContain(SECRET);
    expect(r.stdout).not.toContain(SECRET);
    const named = await run([question, ".", ...kw, "--in", ".env"]);
    expect(named.code).toBe(EXIT.USAGE);
    expect(named.log.requests.length).toBe(0);
    const nested = await run([question, ".", ...kw, "--in", "config/secrets.yml"]);
    expect(nested.code).toBe(EXIT.USAGE);
  });

  test("derives keywords when none are given and says so", async () => {
    const r = await run([question]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stderr).toContain("no --keyword given; searched for: ");
    expect(r.stderr).toContain("compaction token");
  });

  test("--json prints one object with passages, leads, status and stats", async () => {
    const r = await run([question, ".", ...kw, "-s", "When does a turn compact?", "--json", "-q"]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout);
    expect(out.genigrep).toMatch(/^\d+\.\d+\.\d+/);
    expect(out.engine).toBe("scout-0.3.1");
    expect(out.keywordsDerived).toBe(false);
    expect(out.subQuestions).toEqual(["When does a turn compact?"]);
    expect(out.passages.length).toBeGreaterThan(0);
    expect(out.passages[0]).toMatchObject({ path: expect.any(String), start: expect.any(Number), lines: expect.any(String) });
    expect(out.passages[0].coverage.length).toBe(1);
    expect(out.stats.jev.requests).toBeGreaterThan(0);
    expect(typeof out.text).toBe("string");
  });

  test("--in focuses the search, relative to the searched directory or absolute inside it", async () => {
    const r = await run([question, ".", ...kw, "--in", "docs", "--in", join(repo, "src"), "--json"]);
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.stdout).paths).toEqual(["docs", "src"]);
    const sub = await run([question, "src", ...kw, "--json"]);
    expect(sub.code).toBe(EXIT.OK);
    const paths = JSON.parse(sub.stdout).passages.map((p: { path: string }) => p.path);
    expect(paths).toContain("compaction.ts");
  });

  test("a file path is refused with a hint", async () => {
    const r = await run([question, "src/turn.ts", ...kw]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("--in turn.ts");
  });

  test("--verbose adds keywords, stages and counts", async () => {
    const r = await run([question, ".", ...kw, "-v"]);
    expect(r.stderr).toContain("genigrep: keywords: compactionThresholdTokens, compactNow");
    expect(r.stderr).toContain("genigrep: stages: recall ");
    expect(r.stderr).toMatch(/candidate files, \d+ selected/);
  });

  test("nothing found exits 1", async () => {
    const r = await run(["Where is the frobnicator configured?", ".", "-k", "frobnicatorSetting,FROBNICATE_MODE"]);
    expect(r.code).toBe(EXIT.NO_RESULTS);
    expect(r.stdout).toContain("No passage passed verification");
  });

  test("no API key exits 3 with a hint", async () => {
    const r = await run([question, ".", ...kw], { withKey: false });
    expect(r.code).toBe(EXIT.SETUP);
    expect(r.stderr).toContain("ggr auth");
  });

  test("a missing directory exits 3", async () => {
    const r = await run([question, "no/such/dir", ...kw]);
    expect(r.code).toBe(EXIT.SETUP);
  });

  test("invalid arguments exit 2", async () => {
    expect((await run(["hi", ".", ...kw])).code).toBe(EXIT.USAGE);
    expect((await run([question, ".", ...kw, "-b", "10"])).code).toBe(EXIT.USAGE);
    expect((await run([question, ".", ...kw, "--in", "../outside"])).code).toBe(EXIT.USAGE);
    expect((await run([question, ".", ...kw, "--in", "/"])).code).toBe(EXIT.USAGE);
    const many = Array.from({ length: 21 }, (_, i) => `kw${i}`).join(",");
    expect((await run([question, ".", "-k", many])).code).toBe(EXIT.USAGE);
  });

  test("a rejected key exits 4 and points to ggr auth", async () => {
    const r = await run([question, ".", ...kw], { jev: { rejectStatus: 401 } });
    expect(r.code).toBe(EXIT.JEV);
    expect(r.stderr).toContain("Jev rejected the API key (HTTP 401)");
    expect(r.stderr).toContain("Search with rg or grep instead.");
  });

  test("an outage exits 4; with --json the error is JSON on stdout", async () => {
    const r = await run([question, ".", ...kw, "--json"], { jev: { fail: true } });
    expect(r.code).toBe(EXIT.JEV);
    const out = JSON.parse(r.stdout);
    expect(out.error.kind).toBe("jev_unavailable");
    expect(out.error.message).toContain("Jev is unavailable");
  });

  test("an aborted search exits 130", async () => {
    const controller = new AbortController();
    controller.abort(new Error("interrupted"));
    const r = await run([question, ".", ...kw], { signal: controller.signal });
    expect(r.code).toBe(EXIT.INTERRUPTED);
  });

  test("the key never appears in any output", async () => {
    const runs = await Promise.all([
      run([question, ".", ...kw, "-v"]),
      run([question, ".", ...kw, "--json"]),
      run([question, ".", ...kw], { jev: { rejectStatus: 403 } }),
      run(["doctor"]),
      run(["auth", "--status"]),
    ]);
    for (const r of runs) {
      expect(r.stdout).not.toContain(KEY);
      expect(r.stderr).not.toContain(KEY);
    }
  });
});

describe("ggr auth", () => {
  test("verifies, stores the key with mode 600, reports and removes it", async () => {
    const cfg = temp("genigrep-auth-");
    const env = { XDG_CONFIG_HOME: cfg };
    const saved = await run(["auth"], { env, withKey: false, secret: KEY });
    expect(saved.code).toBe(EXIT.OK);
    expect(saved.log.requests.length).toBe(1);
    const path = join(cfg, "genigrep", "config.json");
    expect(JSON.parse(readFileSync(path, "utf8")).jevApiKey).toBe(KEY);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(saved.stdout).toContain("Stored the Jev API key");
    const status = await run(["auth", "--status"], { env, withKey: false });
    expect(status.code).toBe(EXIT.OK);
    expect(status.stdout).toContain(`stored in ${path}`);
    const removed = await run(["auth", "--remove"], { env, withKey: false });
    expect(removed.stdout).toContain("Removed the key");
    expect((await run(["auth", "--status"], { env, withKey: false })).code).toBe(EXIT.SETUP);
    for (const r of [saved, status, removed]) {
      expect(r.stdout + r.stderr).not.toContain(KEY);
    }
  });

  test("a key Jev rejects is not stored", async () => {
    const cfg = temp("genigrep-auth-");
    const r = await run(["auth"], { env: { XDG_CONFIG_HOME: cfg }, withKey: false, secret: KEY, jev: { rejectStatus: 401 } });
    expect(r.code).toBe(EXIT.JEV);
    expect(r.stderr).toContain("nothing was stored");
    expect(() => statSync(join(cfg, "genigrep", "config.json"))).toThrow();
  });

  test("--no-verify stores without calling Jev; an empty or malformed key is refused", async () => {
    const cfg = temp("genigrep-auth-");
    const env = { XDG_CONFIG_HOME: cfg };
    const r = await run(["auth", "--no-verify"], { env, withKey: false, secret: KEY });
    expect(r.code).toBe(EXIT.OK);
    expect(r.log.requests.length).toBe(0);
    expect((await run(["auth"], { env, withKey: false, secret: null })).code).toBe(EXIT.USAGE);
    expect((await run(["auth"], { env, withKey: false, secret: "has spaces in it" })).code).toBe(EXIT.USAGE);
  });
});

describeWithRipgrep("ggr doctor", () => {
  test("passes with a working key and ripgrep", async () => {
    const r = await run(["doctor"]);
    expect(r.code).toBe(EXIT.OK);
    for (const name of ["runtime", "ripgrep", "search", "config", "api key", "jev"]) {
      expect(r.stdout).toMatch(new RegExp(`\\n  ok    ${name}`));
    }
  });

  test("fails with exit 3 without a key and 4 when Jev rejects it", async () => {
    const none = await run(["doctor", "--json"], { withKey: false });
    expect(none.code).toBe(EXIT.SETUP);
    const out = JSON.parse(none.stdout);
    expect(out.ok).toBe(false);
    expect(out.checks.find((c: { name: string }) => c.name === "api key").ok).toBe(false);
    const rejected = await run(["doctor"], { jev: { rejectStatus: 401 } });
    expect(rejected.code).toBe(EXIT.JEV);
    expect(rejected.stdout).toContain("FAIL  jev");
  });

  test("fails with exit 3 when ripgrep is missing", async () => {
    const r = await run(["doctor"], { env: { GENIGREP_RG_PATH: "/nonexistent/rg" } });
    expect(r.code).toBe(EXIT.SETUP);
    expect(r.stdout).toContain("FAIL  ripgrep");
  });
});

describe("ggr --version and --help", () => {
  test("print and exit 0", async () => {
    const v = await run(["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout).toMatch(/^genigrep \d+\.\d+\.\d+\n$/);
    const h = await run(["--help"]);
    expect(h.stdout).toContain("Exit codes:");
    expect(h.stdout).toContain("it cannot see what the search missed");
  });
});
