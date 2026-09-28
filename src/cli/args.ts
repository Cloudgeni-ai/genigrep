/** Command-line parsing (node:util parseArgs, no dependencies). */
import { parseArgs } from "node:util";

export const EXIT = {
  /** Search: the evidence pack has at least one passage. Other commands: success. */
  OK: 0,
  /** Search: no passage passed verification (like grep finding nothing). */
  NO_RESULTS: 1,
  /** Invalid command line or search arguments. */
  USAGE: 2,
  /** Setup problem: no API key, no ripgrep, unreadable config, missing directory. */
  SETUP: 3,
  /** Jev failed: unreachable, timed out, key or billing rejected, or request rejected. */
  JEV: 4,
  /** The search failed for another reason (for example a workspace or ripgrep error). */
  FAILED: 5,
  /** Interrupted (Ctrl-C). */
  INTERRUPTED: 130,
} as const;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface SearchCommand {
  kind: "search";
  question: string;
  /** The directory (or file) to search, as given; undefined means the current directory. */
  target: string | undefined;
  keywords: string[];
  subQuestions: string[];
  paths: string[];
  budget: number | undefined;
  json: boolean;
  verbose: boolean;
  quiet: boolean;
}

export interface AuthCommand {
  kind: "auth";
  action: "save" | "remove" | "status";
  verify: boolean;
}

export interface McpCommand {
  kind: "mcp";
  /** Directories the server may search, as given; empty means the client's roots, else the current directory. */
  directories: string[];
  quiet: boolean;
}

export type HelpTopic = "search" | "auth" | "doctor" | "mcp";

export type Command =
  | SearchCommand
  | AuthCommand
  | McpCommand
  | { kind: "doctor"; json: boolean }
  | { kind: "help"; topic: HelpTopic }
  | { kind: "version" };

const SUBCOMMANDS = new Set(["search", "auth", "doctor", "mcp", "help"]);

function helpTopic(name: string | undefined): HelpTopic {
  return name === "auth" || name === "doctor" || name === "mcp" ? name : "search";
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new UsageError(message.replace(/^TypeError \[[A-Z_]+\]: /, ""));
}

function list(values: string[] | undefined, splitCommas: boolean): string[] {
  const out: string[] = [];
  for (const v of values ?? []) {
    for (const part of splitCommas ? v.split(",") : [v]) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

export function parseCommand(argv: readonly string[]): Command {
  const first = argv[0];
  if (first === "--version" || first === "-V") return { kind: "version" };
  if (first === undefined || first === "--help" || first === "-h") return { kind: "help", topic: "search" };
  const sub = SUBCOMMANDS.has(first) ? first : "search";
  const rest = sub === "search" && first !== "search" ? argv : argv.slice(1);
  if (sub === "help") return { kind: "help", topic: helpTopic(rest[0]) };
  if (rest.includes("--help") || rest.includes("-h")) return { kind: "help", topic: helpTopic(sub) };
  if (sub === "auth") return parseAuth(rest);
  if (sub === "doctor") return parseDoctor(rest);
  if (sub === "mcp") return parseMcp(rest);
  return parseSearch(rest);
}

function parseAuth(args: readonly string[]): AuthCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        "no-verify": { type: "boolean" },
        remove: { type: "boolean" },
        status: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    fail(error);
  }
  const v = parsed.values;
  if (v.remove && v.status) throw new UsageError("use either --remove or --status");
  return {
    kind: "auth",
    action: v.remove ? "remove" : v.status ? "status" : "save",
    verify: !v["no-verify"],
  };
}

function parseDoctor(args: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: { json: { type: "boolean" } },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    fail(error);
  }
  return { kind: "doctor", json: Boolean(parsed.values.json) };
}

function parseMcp(args: readonly string[]): McpCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: { quiet: { type: "boolean", short: "q" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    fail(error);
  }
  return { kind: "mcp", directories: parsed.positionals, quiet: Boolean(parsed.values.quiet) };
}

function parseSearch(args: readonly string[]): SearchCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        keyword: { type: "string", short: "k", multiple: true },
        sub: { type: "string", short: "s", multiple: true },
        in: { type: "string", multiple: true },
        budget: { type: "string", short: "b" },
        json: { type: "boolean" },
        verbose: { type: "boolean", short: "v" },
        quiet: { type: "boolean", short: "q" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    fail(error);
  }
  const v = parsed.values;
  const positionals = parsed.positionals;
  if (!positionals.length) throw new UsageError("missing the question; see ggr --help");
  if (positionals.length > 2) {
    throw new UsageError(
      `expected a question and at most one directory, got ${positionals.length} arguments; quote the question`,
    );
  }
  let budget: number | undefined;
  if (v.budget !== undefined) {
    budget = Number(v.budget);
    if (!Number.isInteger(budget)) throw new UsageError("--budget must be a whole number of tokens");
  }
  if (v.verbose && v.quiet) throw new UsageError("use either --verbose or --quiet");
  return {
    kind: "search",
    question: positionals[0]!,
    target: positionals[1],
    keywords: list(v.keyword, true),
    subQuestions: list(v.sub, false),
    paths: list(v.in, false),
    budget,
    json: Boolean(v.json),
    verbose: Boolean(v.verbose),
    quiet: Boolean(v.quiet),
  };
}
