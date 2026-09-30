import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodeSearchRipgrepMissingError, CodeSearchWorkspaceError } from "../src/engine";
import { findRipgrep } from "../src/ripgrep";
import { DEPENDENCY_EXCLUDE_GLOBS, SECRET_EXCLUDE_GLOBS, isSecretDirectory, isSecretPath } from "../src/workspace/excludes";
import {
  LocalWorkspace,
  cutAtRecordBoundary,
  validateRipgrepArgs,
} from "../src/workspace/local";

const rg = findRipgrep();
const describeWithRipgrep = rg ? describe : describe.skip;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), "genigrep-ws-"));
  dirs.push(root);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  return root;
}

const timeout = { timeoutMs: 20_000 };
const listArgs = ["--files", "--hidden", "--no-require-git", "--null", "--", "."];
const files = (stdout: string) => stdout.split("\0").filter(Boolean).map((p) => p.replace(/^\.\//, "")).sort();

describe("validateRipgrepArgs", () => {
  test("accepts the engine's flags", () => {
    const r = validateRipgrepArgs([
      "--line-number",
      "--with-filename",
      "--no-heading",
      "--color",
      "never",
      "-i",
      "-m",
      "25",
      "--max-columns",
      "8000",
      "--max-filesize",
      "4000000",
      "-g",
      "!**/node_modules/**",
      "-e",
      "foo|bar",
      "--",
      ".",
      "src/app",
    ]);
    expect(r.paths).toEqual([".", "src/app"]);
    expect(r.flags).toContain("-e");
  });

  test("rejects flags outside the allowlist and unsafe paths", () => {
    const bad: string[][] = [
      ["--pre", "cat", "--", "."],
      ["-f", "patterns.txt", "--", "."],
      ["--follow", "--", "."],
      ["--color", "always", "--", "."],
      ["-m", "0", "--", "."],
      ["-e", "x".repeat(16_385), "--", "."],
      ["-e", "foo"],
      ["-e", "foo", "--"],
      ["-e", "foo", "--", "/etc"],
      ["-e", "foo", "--", "../x"],
      ["-e", "foo", "--", "a/../../x"],
      ["-e", "foo", "--", "-rf"],
      ["-e", "fo\0o", "--", "."],
    ];
    for (const args of bad) expect(() => validateRipgrepArgs(args)).toThrow(CodeSearchWorkspaceError);
  });
});

describe("cutAtRecordBoundary", () => {
  test("keeps whole lines or NUL-separated records only", () => {
    const enc = new TextEncoder();
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(dec(cutAtRecordBoundary(enc.encode("a:1:x\nb:2:y\nc:3:z\n"), 14))).toBe("a:1:x\nb:2:y\n");
    expect(dec(cutAtRecordBoundary(enc.encode("a\0bb\0ccc\0"), 7))).toBe("a\0bb\0");
    expect(dec(cutAtRecordBoundary(enc.encode("abcdef"), 3))).toBe("");
  });
});

describe("isSecretPath", () => {
  test("flags credential files and keeps ordinary and example files", () => {
    const secret = [
      ".env",
      "app/.env",
      ".env.local",
      ".env.production.local",
      ".env.production",
      ".envrc",
      ".npmrc",
      "deploy/prod.tfvars",
      "infra/terraform.tfstate",
      "infra/terraform.tfstate.backup",
      "certs/server.pem",
      "certs/server.key",
      "id_ed25519",
      "id_rsa.pub",
      "config/secrets.yml",
      "gcp-credentials.json",
      "ci/service-account-prod.json",
      ".ssh/config",
      "home/.aws/credentials",
      ".docker/config.json",
      ".ssh",
      "home/.aws",
      ".ENV",
      "certs/Server.PEM",
      "GoogleCredentials.json",
      ".Env.Production",
      ".SSH/config",
      ".env.qa",
      "prod.tfvars.json",
      "AuthKey_ABC123.p8",
      ".vault-token",
      ".config/gh/hosts.yml",
      ".cargo/credentials.toml",
      ".gem/credentials",
      ".opengeni/codemode-tokens/0f3a",
      "repo/.Azure/msal_token_cache.json",
      ".config/opengeni/agent.json",
      ".azure",
    ];
    const ordinary = [
      ".env.example",
      ".env.sample",
      "src/env.ts",
      "src/credentials/index.ts",
      "src/secrets.ts",
      "docs/keys.md",
      "config.json",
      "src/kubeconfig/load.go",
      "terraform/main.tf",
      ".ENV.EXAMPLE",
      "src/Credentials/index.ts",
      "credentials",
      "src/gh/hosts.ts",
      "cargo/credentials.rs",
      "src/opengeni/index.ts",
      ".config/other/opengeni.json",
      "docs/azure.md",
    ];
    for (const p of secret) expect([p, isSecretPath(p)]).toEqual([p, true]);
    for (const p of ordinary) expect([p, isSecretPath(p)]).toEqual([p, false]);
  });
});

describeWithRipgrep("LocalWorkspace", () => {
  test("the secret globs and isSecretPath agree", async () => {
    const names = [
      ".env",
      "app/.env",
      ".env.local",
      ".env.production.local",
      ".env.staging",
      ".env.example",
      ".envrc",
      ".npmrc",
      ".yarnrc.yml",
      "prod.tfvars",
      "terraform.tfstate",
      "terraform.tfstate.backup",
      "server.pem",
      "server.key",
      "id_rsa",
      "id_rsa.pub",
      "secrets.yml",
      "secret.json",
      "gcp-credentials.json",
      "service-account.json",
      "ci/service_account_key.json",
      ".ssh/config",
      ".aws/credentials",
      ".kube/config",
      ".docker/config.json",
      "src/env.ts",
      "src/credentials/index.ts",
      "src/secrets.ts",
      "config.json",
      "keys.md",
      ".Env.Local",
      "certs/Server.PEM",
      "GoogleCredentials.json",
      ".env.uat",
      "prod.tfvars.json",
      "AuthKey_ABC123.p8",
      ".vault-token",
      ".config/gh/hosts.yml",
      ".cargo/credentials.toml",
      ".gem/credentials",
      "src/gh/hosts.ts",
      ".opengeni/token",
      ".azure/msal_token_cache.json",
      ".config/opengeni/agent.json",
      ".config/other.json",
    ];
    const root = tree(Object.fromEntries(names.map((n) => [n, "token\n"])));
    // Only the secret globs (the default), not the dependency globs.
    const ws = new LocalWorkspace(root, { excludeGlobs: [] });
    const listed = files((await ws.ripgrep(listArgs, timeout)).stdout);
    const expected = names.filter((n) => !isSecretPath(n)).sort();
    expect(listed).toEqual(expected);
  });

  test("respects .gitignore outside a git repository and skips dependency directories", async () => {
    const root = tree({
      ".gitignore": "generated/\n*.log\n",
      "src/a.ts": "export const needle = 1;\n",
      "generated/b.ts": "export const needle = 2;\n",
      "debug.log": "needle\n",
      ".venv/lib/site.py": "needle = 3\n",
      "Pods/x/y.m": "needle\n",
    });
    // node_modules, dist and the like come from the engine's own excludes, not the adapter's.
    const ws = new LocalWorkspace(root);
    const listed = files((await ws.ripgrep(listArgs, timeout)).stdout);
    expect(listed).toEqual([".gitignore", "src/a.ts"]);
  });

  test("respects .gitignore inside a git repository", async () => {
    const root = tree({ ".gitignore": "ignored.ts\n", "kept.ts": "needle\n", "ignored.ts": "needle\n" });
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
    } catch {
      return; // no git available
    }
    const ws = new LocalWorkspace(root);
    const r = await ws.ripgrep(
      ["--line-number", "--with-filename", "--no-heading", "--color", "never", "-e", "needle", "--", "."],
      timeout,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("kept.ts:1:needle");
    expect(r.stdout).not.toContain("ignored.ts");
  });

  test("never searches an explicitly named secret file", async () => {
    const root = tree({ ".env": "API_TOKEN=live-value\n", "src/a.ts": "API_TOKEN\n" });
    const ws = new LocalWorkspace(root);
    const search = (paths: string[]) =>
      ws.ripgrep(["--line-number", "--with-filename", "--no-heading", "-e", "API_TOKEN", "--", ...paths], timeout);
    const both = await search([".env", "src"]);
    expect(both.stdout).toContain("API_TOKEN");
    expect(both.stdout).not.toContain("live-value");
    const only = await search([".env"]);
    expect(only).toEqual({ stdout: "", exitCode: 1, truncated: false, timedOut: false });
    expect(await ws.readText(".env", { maxBytes: 1000 })).toBeNull();
    expect(await ws.pathKinds([".env", "src"], {})).toEqual({ ".env": "missing", src: "directory" });
  });

  test("never reads a secret file through a link", async () => {
    const root = tree({ ".env": "API_TOKEN=live-value\n" });
    symlinkSync(join(root, ".env"), join(root, "innocent.txt"));
    const ws = new LocalWorkspace(root);
    expect(await ws.readText("innocent.txt", { maxBytes: 1000 })).toBeNull();
  });

  test("reads text within bounds and flags binary files", async () => {
    const root = tree({
      "a.txt": "hello\nworld\n",
      "big.txt": "x".repeat(5000),
      "bin.dat": new Uint8Array([1, 2, 0, 3]),
    });
    const ws = new LocalWorkspace(root, { maxReadBytes: 4096 });
    expect(await ws.readText("a.txt", { maxBytes: 100 })).toEqual({
      text: "hello\nworld\n",
      truncated: false,
      binary: false,
    });
    const big = await ws.readText("big.txt", { maxBytes: 1_000_000 });
    expect(big?.text.length).toBe(4096);
    expect(big?.truncated).toBe(true);
    expect((await ws.readText("big.txt", { maxBytes: 10 }))?.text).toBe("x".repeat(10));
    expect((await ws.readText("bin.dat", { maxBytes: 100 }))?.binary).toBe(true);
    expect(await ws.readText("missing.txt", { maxBytes: 100 })).toBeNull();
    expect(await ws.readText(".", { maxBytes: 100 })).toBeNull();
  });

  test("reads a file whose name starts with a dash, but never passes it to ripgrep bare", async () => {
    const root = tree({ "-notes.ts": "needle\n" });
    const ws = new LocalWorkspace(root);
    expect((await ws.readText("-notes.ts", { maxBytes: 100 }))?.text).toBe("needle\n");
    expect(await ws.pathKinds(["-notes.ts"], {})).toEqual({ "-notes.ts": "file" });
    const search = (path: string) =>
      ws.ripgrep(["--line-number", "--with-filename", "--no-heading", "-e", "needle", "--", path], timeout);
    await expect(search("-notes.ts")).rejects.toThrow(/path is not allowed/);
    expect((await search("./-notes.ts")).stdout).toContain("needle");
  });

  test("never leaves the root", async () => {
    const outside = tree({ "secret.txt": "outside\n" });
    const root = tree({ "in.txt": "inside\n" });
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    symlinkSync(outside, join(root, "linkdir"));
    const ws = new LocalWorkspace(root);
    expect(await ws.readText("link.txt", { maxBytes: 100 })).toBeNull();
    expect(await ws.readText("linkdir/secret.txt", { maxBytes: 100 })).toBeNull();
    expect(await ws.pathKinds(["linkdir", "in.txt"], {})).toEqual({ linkdir: "missing", "in.txt": "file" });
    await expect(ws.readText("../x", { maxBytes: 100 })).rejects.toBeInstanceOf(CodeSearchWorkspaceError);
    await expect(ws.readText("/etc/passwd", { maxBytes: 100 })).rejects.toBeInstanceOf(CodeSearchWorkspaceError);
    await expect(ws.pathKinds(["a/../../x"], {})).rejects.toBeInstanceOf(CodeSearchWorkspaceError);
    const listed = files((await ws.ripgrep(listArgs, timeout)).stdout);
    expect(listed).toEqual(["in.txt"]);
  });

  test("cuts large output at a line boundary and reports it", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `needle ${i}`).join("\n") + "\n";
    const root = tree({ "a.txt": lines });
    const ws = new LocalWorkspace(root, { maxStdoutBytes: 100 });
    const r = await ws.ripgrep(["--line-number", "--no-heading", "-e", "needle", "--", "a.txt"], timeout);
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(100);
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(r.stdout.split("\n").filter(Boolean).every((l) => /^\d+:needle \d+$/.test(l))).toBe(true);
  });

  test("no match is exit code 1 with empty output", async () => {
    const root = tree({ "a.txt": "hay\n" });
    const r = await new LocalWorkspace(root).ripgrep(["-e", "needle", "--", "."], timeout);
    expect(r).toEqual({ stdout: "", exitCode: 1, truncated: false, timedOut: false });
  });

  test("abort stops the search and rejects with the reason", async () => {
    const root = tree({ "a.txt": "needle\n" });
    const ws = new LocalWorkspace(root);
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);
    await expect(ws.ripgrep(["-e", "needle", "--", "."], { ...timeout, signal: controller.signal })).rejects.toBe(
      reason,
    );
  });

  test("a missing binary is CodeSearchRipgrepMissingError", async () => {
    const root = tree({ "a.txt": "needle\n" });
    const ws = new LocalWorkspace(root, { rgPath: join(root, "no-such-rg") });
    await expect(ws.ripgrep(["-e", "needle", "--", "."], timeout)).rejects.toBeInstanceOf(
      CodeSearchRipgrepMissingError,
    );
  });

  test("a time limit kills ripgrep and reports timedOut", async () => {
    const root = tree({ "a.txt": "needle\n" });
    // A fake rg that never finishes: /bin/sh sleeping.
    const fake = join(root, "slow-rg");
    writeFileSync(fake, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const ws = new LocalWorkspace(root, { rgPath: fake });
    const started = Date.now();
    const r = await ws.ripgrep(["-e", "needle", "--", "."], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a missing root is a workspace error", () => {
    expect(() => new LocalWorkspace(join(tmpdir(), "genigrep-does-not-exist-" + Date.now()))).toThrow(
      CodeSearchWorkspaceError,
    );
  });

  test("refuses a root inside a credentials directory", () => {
    const home = tree({ ".aws/credentials": "aws_secret_access_key = x\n", ".ssh/keys/id_rsa": "x\n", "src/a.ts": "x\n" });
    expect(() => new LocalWorkspace(join(home, ".aws"))).toThrow(/credentials directory/);
    expect(() => new LocalWorkspace(join(home, ".ssh", "keys"))).toThrow(/credentials directory/);
    expect(new LocalWorkspace(join(home, "src")).root).toContain("genigrep-ws-");
    expect(isSecretDirectory("/home/u/.kube")).toBe(true);
    expect(isSecretDirectory("/home/u/.azure")).toBe(true);
    expect(isSecretDirectory("/home/u/.config/opengeni/state")).toBe(true);
    expect(isSecretDirectory("/home/u/.config")).toBe(false);
    expect(isSecretDirectory("/home/u/projects/kube")).toBe(false);
  });

  test("secret and dependency globs are separate negations", () => {
    for (const g of [...SECRET_EXCLUDE_GLOBS, ...DEPENDENCY_EXCLUDE_GLOBS]) expect(g.startsWith("!")).toBe(true);
    expect(SECRET_EXCLUDE_GLOBS.some((g) => DEPENDENCY_EXCLUDE_GLOBS.includes(g))).toBe(false);
  });

  test("a named link to a secret file or directory inside the root is neither searched nor classified", async () => {
    const root = tree({
      ".env.production": "API_TOKEN=live-value\n",
      ".aws/credentials": "API_TOKEN=live-value\n",
      "src/a.ts": "API_TOKEN\n",
    });
    symlinkSync(".env.production", join(root, "notes.txt"));
    symlinkSync(".aws", join(root, "cfg"));
    const ws = new LocalWorkspace(root);
    const r = await ws.ripgrep(
      ["--line-number", "--with-filename", "--no-heading", "-e", "API_TOKEN", "--", "notes.txt", "cfg", "src"],
      timeout,
    );
    expect(r.stdout).toContain("src/a.ts");
    expect(r.stdout).not.toContain("live-value");
    expect(await ws.pathKinds(["notes.txt", "cfg", "src"], {})).toEqual({
      "notes.txt": "missing",
      cfg: "missing",
      src: "directory",
    });
    expect(await ws.readText("cfg/credentials", { maxBytes: 100 })).toBeNull();
  });
});
