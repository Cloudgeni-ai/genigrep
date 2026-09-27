/** The genigrep command line. `main` takes its I/O as arguments so tests can drive it in-process. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CodeSearchArgumentError,
  CodeSearchRipgrepMissingError,
  CodeSearchWorkspaceError,
  JevClient,
  JevRequestError,
  JevUnavailableError,
  noul,
  type JevFetch,
} from "../engine";
import {
  ConfigError,
  ENV_API_KEY,
  checkApiKeyShape,
  loadSettings,
  removeApiKey,
  saveApiKey,
  type Settings,
} from "../config";
import { genigrep, type GenigrepResult } from "../genigrep";
import { findRipgrep } from "../ripgrep";
import { VERSION } from "../version";
import { isSecretPath } from "../workspace/excludes";
import { LocalWorkspace } from "../workspace/local";
import { EXIT, UsageError, parseCommand, type AuthCommand, type SearchCommand } from "./args";
import { AUTH_HELP, DOCTOR_HELP, SEARCH_HELP } from "./help";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Cancels a running command (Ctrl-C). */
  signal?: AbortSignal | undefined;
  /** Read the API key: prompt without echo on a terminal, else read stdin. Null when nothing was entered. */
  readSecret: (prompt: string) => Promise<string | null>;
  /** Tests only: replaces global fetch for Jev requests. */
  fetch?: JevFetch | undefined;
}

class InterruptedError extends Error {}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`genigrep: ${error.message}\n`);
      return EXIT.USAGE;
    }
    throw error;
  }
  switch (command.kind) {
    case "version":
      io.stdout(`genigrep ${VERSION}\n`);
      return EXIT.OK;
    case "help":
      io.stdout(command.topic === "auth" ? AUTH_HELP : command.topic === "doctor" ? DOCTOR_HELP : SEARCH_HELP);
      return EXIT.OK;
    case "auth":
      return await auth(command, io);
    case "doctor":
      return await doctor(command.json, io);
    case "search":
      return await search(command, io);
  }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

type ErrorKind =
  | "usage"
  | "setup"
  | "jev_unavailable"
  | "jev_rejected"
  | "workspace"
  | "interrupted"
  | "failed";

const KIND_EXIT: Record<ErrorKind, number> = {
  usage: EXIT.USAGE,
  setup: EXIT.SETUP,
  jev_unavailable: EXIT.JEV,
  jev_rejected: EXIT.JEV,
  workspace: EXIT.FAILED,
  interrupted: EXIT.INTERRUPTED,
  failed: EXIT.FAILED,
};

const FALLBACK = "Search with rg or grep instead.";

function oneLine(text: string, max = 300): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** A failure as a kind and a message for people (and agents reading stderr). */
function describeFailure(error: unknown, signal: AbortSignal | undefined): { kind: ErrorKind; message: string } {
  if (signal?.aborted || error instanceof InterruptedError) return { kind: "interrupted", message: "interrupted" };
  if (error instanceof UsageError || error instanceof CodeSearchArgumentError) {
    return { kind: "usage", message: oneLine(error.message) };
  }
  if (error instanceof ConfigError) return { kind: "setup", message: oneLine(error.message) };
  if (error instanceof CodeSearchRipgrepMissingError) {
    return {
      kind: "setup",
      message: `${oneLine(error.message)}. Install ripgrep (https://github.com/BurntSushi/ripgrep) or set GENIGREP_RG_PATH.`,
    };
  }
  if (error instanceof JevUnavailableError) {
    if (error.status === 401 || error.status === 403) {
      return {
        kind: "jev_unavailable",
        message: `Jev rejected the API key (HTTP ${error.status}). Run \`genigrep auth\` to store a valid key. ${FALLBACK}`,
      };
    }
    if (error.status === 402) {
      return {
        kind: "jev_unavailable",
        message: `Jev refused the request for billing or credits (HTTP 402). ${FALLBACK}`,
      };
    }
    return { kind: "jev_unavailable", message: `Jev is unavailable (${oneLine(error.message)}). ${FALLBACK}` };
  }
  if (error instanceof JevRequestError) {
    return { kind: "jev_rejected", message: `Jev rejected the request (${oneLine(error.message)}). ${FALLBACK}` };
  }
  if (error instanceof CodeSearchWorkspaceError) {
    return { kind: "workspace", message: `cannot search this directory (${oneLine(error.message)}). ${FALLBACK}` };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "failed", message: `search failed unexpectedly (${oneLine(message)}). ${FALLBACK}` };
}

/** Root directory and workspace-relative --in paths for a search command. */
async function resolveTarget(
  command: SearchCommand,
  cwd: string,
): Promise<{ root: string; paths: string[] }> {
  const target = resolve(cwd, command.target ?? ".");
  let st;
  try {
    st = await stat(target);
  } catch {
    throw new ConfigError(`no such file or directory: ${command.target ?? target}`);
  }
  if (!st.isDirectory()) {
    const hint = st.isFile()
      ? `; to focus on a file, pass its directory and --in ${basename(target)}`
      : "";
    throw new UsageError(`${command.target} is not a directory${hint}`);
  }
  const paths = command.paths.map((p) => {
    let rel = p;
    if (isAbsolute(p)) {
      rel = relative(target, p);
      if (rel === "") rel = ".";
      if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
        throw new UsageError(`--in ${p} is outside the searched directory ${target}`);
      }
    }
    rel = rel.split(sep).join("/");
    if (isSecretPath(rel)) throw new UsageError(`--in ${p} looks like a secret file; genigrep never searches it`);
    return rel;
  });
  return { root: target, paths };
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtUsd(n: number): string {
  return `$${n > 0 && n < 0.0001 ? n.toFixed(6) : n.toFixed(4)}`;
}

function summaryLine(r: GenigrepResult): string {
  const s = r.stats;
  const files = new Set(r.passages.map((p) => p.path)).size;
  return (
    `genigrep: ${r.passages.length} passages from ${files} files, ~${fmtTokens(s.packTokensEst)} tokens` +
    ` | ${(s.wallMs / 1000).toFixed(1)}s` +
    ` | jev ${s.jev.requests} requests, ${fmtTokens(s.jev.inputTokens)} input tokens, ${fmtUsd(s.jev.costUsd)}\n`
  );
}

function verboseLines(r: GenigrepResult): string {
  const s = r.stats;
  const stages = Object.entries(s.stageMs)
    .map(([k, ms]) => `${k} ${(ms / 1000).toFixed(2)}s`)
    .join(", ");
  return [
    `genigrep: searched ${r.root}${r.paths.length ? ` (in ${r.paths.join(", ")})` : ""}`,
    `genigrep: keywords${r.keywordsDerived ? " (derived)" : ""}: ${r.keywords.join(", ")}`,
    `genigrep: stages: ${stages}`,
    `genigrep: ${s.candidates} candidate files, ${s.filesSelected} selected, ${s.passagesVerified} passages verified, ` +
      `${s.passagesIncluded} included; ${s.workspaceCalls} workspace calls; model ${s.jev.model ?? "?"}` +
      (s.ripgrepTruncated ? "; ripgrep output was partial" : ""),
    `genigrep: evidence rating ${r.status.label}${r.status.overall === null ? "" : ` (${r.status.overall.toFixed(2)})`}` +
      (r.status.error ? `; check failed: ${oneLine(r.status.error, 160)}` : ""),
    "",
  ].join("\n");
}

function jsonResult(r: GenigrepResult): string {
  return (
    JSON.stringify(
      {
        genigrep: VERSION,
        engine: r.version,
        root: r.root,
        question: r.question,
        keywords: r.keywords,
        keywordsDerived: r.keywordsDerived,
        subQuestions: r.subQuestions,
        paths: r.paths,
        status: r.status,
        passages: r.passages,
        leads: r.leads,
        stats: r.stats,
        text: r.text,
      },
      null,
      2,
    ) + "\n"
  );
}

async function search(command: SearchCommand, io: CliIo): Promise<number> {
  const report = (error: unknown): number => {
    const { kind, message } = describeFailure(error, io.signal);
    if (command.json) io.stdout(JSON.stringify({ error: { kind, message } }, null, 2) + "\n");
    else io.stderr(`genigrep: ${message}\n`);
    return KIND_EXIT[kind];
  };
  let settings: Settings;
  let target: { root: string; paths: string[] };
  try {
    settings = await loadSettings(io.env);
    for (const w of settings.warnings) io.stderr(`genigrep: warning: ${w}\n`);
    if (!settings.apiKey) {
      throw new ConfigError(
        `no Jev API key. Run \`genigrep auth\` or set ${ENV_API_KEY} (see genigrep help auth)`,
      );
    }
    target = await resolveTarget(command, io.cwd);
    if (!findRipgrep(io.env)) {
      throw new CodeSearchRipgrepMissingError("ripgrep (rg) was not found");
    }
  } catch (error) {
    return report(error);
  }
  try {
    const result = await genigrep({
      question: command.question,
      keywords: command.keywords,
      subQuestions: command.subQuestions,
      paths: target.paths,
      root: target.root,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      budgetTokens: command.budget,
      signal: io.signal,
      workspace: { rgPath: findRipgrep(io.env)?.path },
      fetch: io.fetch,
    });
    if (result.keywordsDerived && !command.quiet && !command.json && !command.verbose) {
      io.stderr(
        `genigrep: no --keyword given; searched for: ${result.keywords.join(", ")}. ` +
          "Likely identifiers (-k) usually find more.\n",
      );
    }
    if (command.json) {
      io.stdout(jsonResult(result));
    } else {
      io.stdout(result.text);
      if (command.verbose) io.stderr(verboseLines(result));
    }
    if (!command.quiet) io.stderr(summaryLine(result));
    return result.passages.length ? EXIT.OK : EXIT.NO_RESULTS;
  } catch (error) {
    return report(error);
  }
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

/** One tiny Jev call: proves the key, the endpoint and the network. */
async function probeJev(
  settings: Pick<Settings, "baseUrl" | "model" | "timeoutMs">,
  apiKey: string,
  io: CliIo,
) {
  const client = new JevClient({
    apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    maxRetries: 1,
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  const started = performance.now();
  const r = await client.ask(
    { probe: "genigrep connectivity check" },
    { ok: noul("Is `probe` a short piece of English text?") },
    { tag: "probe", signal: io.signal },
  );
  return { ms: Math.round(performance.now() - started), model: r.model, tokens: r.usage.inputTokens, costUsd: r.costUsd };
}

async function auth(command: AuthCommand, io: CliIo): Promise<number> {
  let settings: Settings;
  try {
    settings = await loadSettings(io.env);
  } catch (error) {
    io.stderr(`genigrep: ${describeFailure(error, io.signal).message}\n`);
    return EXIT.SETUP;
  }
  const envNote = io.env[ENV_API_KEY]?.trim()
    ? `Note: ${ENV_API_KEY} is set in this environment and takes precedence over the stored key.\n`
    : "";
  if (command.action === "status") {
    const where =
      settings.apiKeySource === "env"
        ? `set in ${ENV_API_KEY}`
        : settings.apiKeySource === "config"
          ? `stored in ${settings.configPath}`
          : `not set (run genigrep auth or set ${ENV_API_KEY})`;
    io.stdout(`Jev API key: ${where}\nJev endpoint: ${settings.baseUrl} (model ${settings.model})\n`);
    for (const w of settings.warnings) io.stderr(`genigrep: warning: ${w}\n`);
    return settings.apiKey ? EXIT.OK : EXIT.SETUP;
  }
  if (command.action === "remove") {
    try {
      const removed = await removeApiKey(settings.configPath);
      io.stdout(removed ? `Removed the key from ${settings.configPath}\n` : `No key stored in ${settings.configPath}\n`);
      io.stdout(envNote);
      return EXIT.OK;
    } catch (error) {
      io.stderr(`genigrep: ${describeFailure(error, io.signal).message}\n`);
      return EXIT.SETUP;
    }
  }
  let key: string | null;
  try {
    key = await io.readSecret("TypeSafe Jev API key: ");
  } catch (error) {
    if (error instanceof InterruptedError || io.signal?.aborted) return EXIT.INTERRUPTED;
    throw error;
  }
  key = key?.trim() ?? "";
  const shape = checkApiKeyShape(key);
  if (shape) {
    io.stderr(`genigrep: ${shape}; nothing was stored\n`);
    return EXIT.USAGE;
  }
  if (command.verify) {
    try {
      const p = await probeJev(settings, key, io);
      io.stderr(`genigrep: Jev accepted the key (${p.model || "model ?"}, ${p.ms} ms)\n`);
    } catch (error) {
      const { kind, message } = describeFailure(error, io.signal);
      if (kind === "interrupted") return EXIT.INTERRUPTED;
      io.stderr(`genigrep: ${message.replace(/ Search with rg or grep instead\.$/, "")}\n`);
      io.stderr("genigrep: nothing was stored (use --no-verify to store the key anyway)\n");
      return EXIT.JEV;
    }
  }
  try {
    await saveApiKey(settings.configPath, key);
  } catch (error) {
    io.stderr(`genigrep: cannot store the key: ${describeFailure(error, io.signal).message}\n`);
    return EXIT.SETUP;
  }
  io.stdout(`Stored the Jev API key in ${settings.configPath} (mode 600)\n${envNote}`);
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Exit code when this check fails. */
  failExit: number;
}

function ripgrepVersion(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(path, ["--version"], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout.split("\n")[0]?.replace(/^ripgrep\s+/, "").trim() || "unknown");
    });
  });
}

async function doctor(json: boolean, io: CliIo): Promise<number> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, failExit: number = EXIT.SETUP) =>
    checks.push({ name, ok, detail, failExit });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node v${process.versions.node}`;
  add("runtime", process.versions.bun !== undefined || nodeMajor >= 20, `${runtime}, ${process.platform} ${process.arch}${nodeMajor < 20 && !process.versions.bun ? " (Node 20 or newer is required)" : ""}`);

  const rg = findRipgrep(io.env);
  if (!rg) {
    add("ripgrep", false, "not found: install ripgrep or set GENIGREP_RG_PATH");
  } else {
    try {
      const version = await ripgrepVersion(rg.path);
      add("ripgrep", true, `${version} (${rg.source}: ${rg.path})`);
      const dir = await mkdtemp(join(tmpdir(), "genigrep-doctor-"));
      try {
        await writeFile(join(dir, "probe.txt"), "genigrep_doctor_probe\n");
        const ws = new LocalWorkspace(dir, { rgPath: rg.path });
        const started = performance.now();
        const r = await ws.ripgrep(
          ["--line-number", "--with-filename", "--no-heading", "--color", "never", "-e", "genigrep_doctor_probe", "--", "."],
          { timeoutMs: 10_000 },
        );
        const found = r.exitCode === 0 && r.stdout.includes("probe.txt:1:");
        add("search", found, found ? `ripgrep found the probe file (${Math.round(performance.now() - started)} ms)` : `ripgrep did not find the probe file (exit ${r.exitCode})`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (error) {
      add("ripgrep", false, `${rg.path} does not run: ${oneLine(error instanceof Error ? error.message : String(error), 160)}`);
    }
  }

  let settings: Settings | null = null;
  try {
    settings = await loadSettings(io.env);
    const perms = settings.warnings.length ? `; ${settings.warnings.join("; ")}` : "";
    add("config", settings.warnings.length === 0, `${settings.configPath}${perms}`);
  } catch (error) {
    add("config", false, describeFailure(error, io.signal).message);
  }
  if (settings) {
    if (!settings.apiKey) {
      add("api key", false, `not set: run genigrep auth or set ${ENV_API_KEY}`);
    } else {
      add("api key", true, settings.apiKeySource === "env" ? `from ${ENV_API_KEY}` : `stored in ${settings.configPath}`);
      try {
        const p = await probeJev(settings, settings.apiKey, io);
        add("jev", true, `${p.model || "?"} answered in ${p.ms} ms at ${settings.baseUrl} (${p.tokens} input tokens, ${fmtUsd(p.costUsd)})`, EXIT.JEV);
      } catch (error) {
        add("jev", false, describeFailure(error, io.signal).message.replace(/ Search with rg or grep instead\.$/, ""), EXIT.JEV);
      }
    }
  }

  const failed = checks.filter((c) => !c.ok);
  if (json) {
    io.stdout(JSON.stringify({ genigrep: VERSION, ok: failed.length === 0, checks: checks.map(({ failExit: _f, ...c }) => c) }, null, 2) + "\n");
  } else {
    io.stdout(`genigrep ${VERSION}\n`);
    for (const c of checks) io.stdout(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(8)}  ${c.detail}\n`);
  }
  if (!failed.length) return EXIT.OK;
  return failed.some((c) => c.failExit === EXIT.SETUP) ? EXIT.SETUP : EXIT.JEV;
}

export { InterruptedError };
