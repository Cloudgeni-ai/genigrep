import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { CodeSearchWorkspaceError, codeSearchConfig, runCodeSearch } from "../../src/engine";
import { cleanPrefix, excludeArgs } from "../../src/engine/code-search/recall";
import { findRipgrep } from "../../src/ripgrep";
import { SECRET_EXCLUDE_GLOBS, isSecretDirectory, isSecretPath } from "../../src/workspace/excludes";
import { LocalWorkspace } from "../../src/workspace/local";
import { FIXTURE_FILES, fakeJevClient, makeFixtureRepo, packPassages } from "./helpers/fixture";
import { LocalCodeSearchWorkspace } from "./helpers/local-workspace";

const describeWithRipgrep = findRipgrep() ? describe : describe.skip;

// Token-shaped test value, never a real credential.
const TOKEN = "ogd_TESTONLYcodemodeBearer0123456789abcdefABCDEF";
const SECRET_LINE = `codemodeBearerToken=${TOKEN}`;

/** Platform credential material an agent's workspace can hold next to its code. */
const SECRET_FILES: Record<string, string> = {
  ".opengeni/codemode-tokens/0f3a": `${SECRET_LINE}\n`,
  ".opengeni/git-credentials/github-token": `${SECRET_LINE}\n`,
  "repos/app/.opengeni/codemode-token": `${SECRET_LINE}\n`,
  ".azure/msal_token_cache.json": `{"codemodeBearerToken": "${TOKEN}"}\n`,
  ".config/opengeni/agent/credentials.json": `{"codemodeBearerToken": "${TOKEN}"}\n`,
};
const CODE_FILES: Record<string, string> = {
  "src/codemode.ts": [
    "/** Reads the Codemode bearer token for a command. */",
    "export function codemodeBearerToken(file: string): string {",
    "  return readTokenFile(file);",
    "}",
    "",
  ].join("\n"),
};

const roots: string[] = [];
function repo(): string {
  const root = makeFixtureRepo({
    ...FIXTURE_FILES,
    ...CODE_FILES,
    ...SECRET_FILES,
  });
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const question = "Where does the sandbox keep the codemode bearer token and what is its value?";
const keywords = ["codemodeBearerToken", "codemode token", "ogd", "bearer", "credentials"];

async function search(root: string, paths?: string[]) {
  const ws = new LocalCodeSearchWorkspace(root);
  const result = await runCodeSearch({
    question,
    keywords,
    ...(paths ? { paths } : {}),
    workspace: ws,
    // never widen past a path that matched: the path itself must be what keeps the files out
    config: codeSearchConfig({ recall: { minCandidatesBeforeWiden: 1 } }),
    // the judge accepts anything that mentions the token, so only exclusion can keep it out
    jev: fakeJevClient({ good: ["codemodeBearerToken", "ogd_"] }),
  });
  const read = ws.calls.filter((c) => c.kind === "readText").flatMap((c) => c.args);
  return { result, read };
}

function expectNoSecret(text: string, read: readonly string[]) {
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain("codemodeBearerToken=");
  const passages = packPassages(text).map((p) => p.path);
  expect(passages.some((p) => /\.opengeni|\.azure|\.config\/opengeni/.test(p))).toBe(false);
  expect(read.some((p) => /\.opengeni|\.azure|\.config\/opengeni/.test(p))).toBe(false);
}

describeWithRipgrep("platform credential material is never searched", () => {
  test("a whole-workspace search finds the code but never the credential files", async () => {
    const { result, read } = await search(repo());
    expect(packPassages(result.text).map((p) => p.path)).toContain("src/codemode.ts");
    expectNoSecret(result.text, read);
  });

  test("naming the directory or a file in it as a path does not search it", async () => {
    const root = repo();
    for (const paths of [
      [".opengeni"],
      [".opengeni/codemode-tokens"],
      [".opengeni/codemode-tokens/0f3a"],
      ["./.opengeni/"],
      [".//.opengeni"],
      ["src/../.opengeni"],
      ["repos/app/.opengeni"],
      [".azure"],
      [".config/opengeni/agent"],
    ]) {
      const { result, read } = await search(root, paths);
      expectNoSecret(result.text, read);
    }
  });

  test("a symlink into it is not followed, as a path or during the walk", async () => {
    const root = repo();
    symlinkSync(join(root, ".opengeni"), join(root, "state"));
    symlinkSync(join(root, ".opengeni/codemode-tokens/0f3a"), join(root, "src/token.txt"));
    const walk = await search(root);
    expectNoSecret(walk.result.text, walk.read);
    for (const paths of [["state"], ["state/codemode-tokens"], ["src/token.txt"]]) {
      const { result, read } = await search(root, paths);
      expectNoSecret(result.text, read);
    }
  });
});

describe("the exclusion rule", () => {
  test("every ripgrep call carries the excludes", () => {
    const args = excludeArgs(codeSearchConfig());
    for (const g of ["!**/.opengeni/**", "!**/.azure/**", "!**/.config/opengeni/**"])
      expect(args).toContain(g);
  });

  test("explicit paths into credential directories are refused, in any spelling", () => {
    for (const p of [
      ".opengeni",
      ".opengeni/codemode-tokens",
      "./.opengeni/x",
      ".//.opengeni",
      ".opengeni\\codemode-tokens",
      "repos/x/.opengeni",
      ".OpenGeni/x",
      ".azure",
      "home/.Azure",
      ".config/opengeni",
      ".config/OpenGeni/agent",
      ".config/./opengeni",
      ".config//opengeni/agent",
      "a/../.opengeni",
    ])
      expect(cleanPrefix(p)).toBeNull();
    expect(cleanPrefix("repos/x/src")).toBe("repos/x/src");
    expect(cleanPrefix(".config/other")).toBe(".config/other");
    expect(cleanPrefix(".opengeni-notes")).toBe(".opengeni-notes");
  });
});

describeWithRipgrep("LocalWorkspace keeps credential directories out", () => {
  const listArgs = ["--files", "--hidden", "--no-require-git", "--null", "--", "."];
  const files = (stdout: string) => stdout.split("\0").filter(Boolean).map((p) => p.replace(/^\.\//, ""));

  test("the adapter's own walk and path checks exclude them, whatever case", async () => {
    const root = makeFixtureRepo({ "src/a.ts": "a\n", ".OpenGeni/token": "t\n", ".Azure/cache.json": "c\n" });
    roots.push(root);
    const ws = new LocalWorkspace(root);
    expect(files((await ws.ripgrep(listArgs, { timeoutMs: 20_000 })).stdout)).toEqual(["src/a.ts"]);
    expect(await ws.pathKinds([".OpenGeni", ".Azure/cache.json"], {})).toEqual({
      ".OpenGeni": "missing",
      ".Azure/cache.json": "missing",
    });
    expect(await ws.readText(".OpenGeni/token", { maxBytes: 100 })).toBeNull();
  });

  test("a custom isExcludedPath does not re-admit them", async () => {
    const root = repo();
    symlinkSync(join(root, ".opengeni"), join(root, "state"));
    const ws = new LocalWorkspace(root, { isExcludedPath: () => false, secretGlobs: [] });
    expect(
      await ws.pathKinds([".opengeni", "state", ".config/opengeni/agent", ".config/./opengeni/agent"], {}),
    ).toEqual({
      ".opengeni": "missing",
      state: "missing",
      ".config/opengeni/agent": "missing",
      ".config/./opengeni/agent": "missing",
    });
    expect(await ws.readText(".opengeni/codemode-tokens/0f3a", { maxBytes: 100 })).toBeNull();
    expect(await ws.readText("state/codemode-tokens/0f3a", { maxBytes: 100 })).toBeNull();
    const named = await ws.ripgrep(["-e", "codemode", "--", ".opengeni", "state"], { timeoutMs: 20_000 });
    expect(named.stdout).toBe("");
  });

  test("a search rooted inside one is refused", () => {
    const root = repo();
    for (const dir of [".opengeni/codemode-tokens", ".azure", ".config/opengeni/agent"]) {
      mkdirSync(join(root, dir), { recursive: true });
      expect(() => new LocalWorkspace(join(root, dir))).toThrow(CodeSearchWorkspaceError);
    }
  });
});

describe("genigrep's secret rules cover credential directories", () => {
  test("isSecretPath, isSecretDirectory and the case-insensitive globs", () => {
    for (const p of [
      ".opengeni/x",
      "a/.OpenGeni/b",
      ".azure/msal_token_cache.json",
      ".config/opengeni/c",
      ".config/./opengeni/c",
      ".config//opengeni/agent",
    ])
      expect(isSecretPath(p)).toBe(true);
    expect(isSecretPath(".config/other/c")).toBe(false);
    expect(isSecretPath(".opengeni-notes/x")).toBe(false);
    expect(isSecretDirectory("/workspace/.opengeni")).toBe(true);
    expect(isSecretDirectory("C:\\Users\\me\\.config\\opengeni")).toBe(true);
    expect(isSecretDirectory("/home/me/.config/./opengeni")).toBe(true);
    expect(isSecretDirectory("/workspace/src")).toBe(false);
    for (const g of ["!**/.opengeni/**", "!**/.azure/**", "!**/.config/opengeni/**"])
      expect(SECRET_EXCLUDE_GLOBS).toContain(g);
  });
});
