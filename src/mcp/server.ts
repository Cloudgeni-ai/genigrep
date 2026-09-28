/**
 * The genigrep MCP server: one `code_search` tool over the local project, for agents that speak the Model
 * Context Protocol. It is a thin host around the same engine as the command line, shaped like OpenGeni's
 * worker wrapper: the tool description and instructions are OpenGeni's shipped wording, one circuit breaker
 * per server process, and failures are reported to the agent as tool errors that point it back to rg.
 *
 * Which directories it may search: the directories given on the command line; otherwise the workspace
 * roots the client reports; otherwise the directory the server was started in.
 */
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, ENV_API_KEY, loadSettings } from "../config";
import {
  CODE_SEARCH_DIRECTIVE,
  CODE_SEARCH_TOOL_NAME,
  CodeSearchArgumentError,
  CodeSearchRipgrepMissingError,
  JevCircuitBreaker,
  JevUnavailableError,
  codeSearchInputSchema,
  parseCodeSearchArguments,
  renderCodeSearchError,
  type CodeSearchJsonValue,
  type JevCircuitLease,
  type JevFetch,
} from "../engine";
import { genigrep } from "../genigrep";
import { findRipgrep } from "../ripgrep";
import { VERSION } from "../version";
import { McpError, McpErrorCode, McpServer } from "./protocol";

/** An MCP tool definition as listed by tools/list. */
export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  annotations?: Record<string, unknown>;
}

/** The result of one tools/call. */
export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

/**
 * OpenGeni's shipped tool description, adapted to a standalone server: "the working directory" becomes the
 * project, and the optional `directory` argument is named. From "It ranks files" on, the text is verbatim;
 * its last sentence is the one that stopped agents from over-trusting the search.
 */
export const MCP_TOOL_DESCRIPTION =
  "Find where something is implemented, configured or decided in the code of this project, in one call " +
  "instead of many separate searches and file reads. Give one precise question and 6-15 keywords: likely identifiers, " +
  "file-name fragments, config keys, error strings and synonyms. Optional subQuestions split distinct parts (for " +
  "'is X required?', add one for what could skip or override X); optional paths limit the search; optional directory " +
  "picks another project directory to search. It ranks files and passages with a fast relevance model, follows " +
  "definitions one level, and returns the best passages verbatim with file paths and line numbers, plus an evidence " +
  "rating for those passages. The rating cannot see what the search missed: use the passages instead of re-reading " +
  "them, then check what they do not cover (other entry points, defaults, flags, exceptions) before concluding.";

/** Longest `directory` argument accepted. */
const DIRECTORY_MAX_CHARS = 1000;

const baseProperties = codeSearchInputSchema.properties as { [key: string]: CodeSearchJsonValue };

/** The engine's input schema (question, keywords, subQuestions, paths) plus `directory`. */
export const mcpToolInputSchema: McpTool["inputSchema"] = {
  ...codeSearchInputSchema,
  type: "object",
  properties: {
    ...baseProperties,
    paths: {
      ...(baseProperties.paths as { [key: string]: CodeSearchJsonValue }),
      description:
        "Optional: files or directories to limit the search to, relative to the searched directory. Default: the whole directory.",
    },
    directory: {
      type: "string",
      minLength: 1,
      maxLength: DIRECTORY_MAX_CHARS,
      description:
        "Optional: the directory to search, absolute or relative to the project root. Default: the project root. " +
        "Paths in the result are relative to it.",
    },
  },
};

export const MCP_TOOL: McpTool = {
  name: CODE_SEARCH_TOOL_NAME,
  title: "Search code",
  description: MCP_TOOL_DESCRIPTION,
  inputSchema: mcpToolInputSchema,
  annotations: {
    title: "Search code",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** Instructions the server gives the client: OpenGeni's code_search directive, verbatim. */
export const MCP_SERVER_INSTRUCTIONS = CODE_SEARCH_DIRECTIVE;

const FALLBACK = "Search with rg, grep or file reads instead.";

export type ProjectRootSource = "arguments" | "client" | "cwd";

export interface GenigrepMcpServerOptions {
  /** Directories this server may search (real paths), in order; the first is the default. Empty: ask the client, then use `cwd`. */
  directories?: readonly string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Where the server was started; the last-resort project root. */
  cwd?: string | undefined;
  /** The user's home directory, never searched as an implicit root. Default: os.homedir(). */
  home?: string | undefined;
  /** One line of diagnostics (stderr for the stdio server). Never receives the API key. */
  log?: ((line: string) => void) | undefined;
  /** One breaker per server process (default: a new one). */
  breaker?: JevCircuitBreaker | undefined;
  /** Stops every running search (the process is shutting down). */
  signal?: AbortSignal | undefined;
  /** How long to wait for the client's roots/list answer. */
  rootsTimeoutMs?: number | undefined;
  /** Tests only: replaces global fetch for Jev requests. */
  fetch?: JevFetch | undefined;
}

function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function oneLine(text: string, max = 240): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function realDirectory(path: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Real paths of existing directories, in order, without duplicates. Throws for one that is missing. */
export async function resolveServerDirectories(dirs: readonly string[], cwd: string): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) {
    const real = await realDirectory(resolve(cwd, dir));
    if (!real) throw new ConfigError(`not a directory: ${dir}`);
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/** Split `directory` from the engine's arguments. */
function takeDirectory(args: Record<string, unknown>): { directory: string | undefined; rest: Record<string, unknown> } {
  const { directory, ...rest } = args;
  if (directory === undefined || directory === null) return { directory: undefined, rest };
  if (typeof directory !== "string") throw new CodeSearchArgumentError("directory must be a string");
  const trimmed = directory.trim();
  if (!trimmed) return { directory: undefined, rest };
  if (trimmed.length > DIRECTORY_MAX_CHARS) {
    throw new CodeSearchArgumentError(`directory must be at most ${DIRECTORY_MAX_CHARS} characters`);
  }
  if (trimmed.includes("\0")) throw new CodeSearchArgumentError("directory must not contain NUL");
  return { directory: trimmed, rest };
}

/** The engine's argument check, naming `directory` among the allowed arguments. */
function parseArguments(rest: Record<string, unknown>) {
  try {
    return parseCodeSearchArguments(rest);
  } catch (error) {
    if (error instanceof CodeSearchArgumentError && error.message.endsWith("allowed: question, keywords, subQuestions, paths")) {
      throw new CodeSearchArgumentError(`${error.message}, directory`);
    }
    throw error;
  }
}

/** Model-facing text for a failure, with setup hints the engine's texts do not have. */
function renderFailure(error: unknown): string {
  if (error instanceof ConfigError) return `code_search is not set up (${oneLine(error.message)}). ${FALLBACK}`;
  if (error instanceof JevUnavailableError && (error.status === 401 || error.status === 403)) {
    return (
      `code_search is unavailable: Jev rejected the API key (HTTP ${error.status}). Ask the user to run ` +
      `\`ggr auth\` in a terminal to store a valid key. ${FALLBACK}`
    );
  }
  if (error instanceof JevUnavailableError && error.status === 402) {
    return `code_search is unavailable: Jev refused the request for billing or credits (HTTP 402). ${FALLBACK}`;
  }
  return renderCodeSearchError(error);
}

export function createGenigrepMcpServer(options: GenigrepMcpServerOptions = {}): McpServer {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const log = options.log ?? (() => undefined);
  const breaker = options.breaker ?? new JevCircuitBreaker();
  const fixed = [...(options.directories ?? [])];
  const rootsTimeoutMs = options.rootsTimeoutMs ?? 5_000;

  const server = new McpServer(
    { name: "genigrep", version: VERSION },
    { capabilities: { tools: {} }, instructions: MCP_SERVER_INSTRUCTIONS },
  );

  // The client's roots, fetched on first use and again after it says they changed. A failed listing counts
  // as no roots until then.
  let clientRoots: Promise<string[]> | null = null;
  server.setNotificationHandler("notifications/roots/list_changed", () => {
    clientRoots = null;
  });

  async function listClientRoots(): Promise<string[]> {
    if (!server.getClientCapabilities()?.roots) return [];
    try {
      const result = await server.request("roots/list", {}, rootsTimeoutMs);
      const roots = (result as { roots?: unknown } | null)?.roots;
      if (!Array.isArray(roots)) throw new Error("roots/list returned no roots array");
      const dirs: string[] = [];
      for (const root of roots as Array<{ uri?: unknown }>) {
        if (typeof root?.uri !== "string" || !root.uri.startsWith("file:")) continue;
        let path: string;
        try {
          path = fileURLToPath(root.uri);
        } catch {
          continue;
        }
        const real = await realDirectory(path);
        if (real && !dirs.includes(real)) dirs.push(real);
      }
      return dirs;
    } catch (error) {
      // Kept until the client says its roots changed, so a client that never answers costs one timeout.
      log(`ggr mcp: could not list the client's roots (${oneLine(error instanceof Error ? error.message : String(error), 160)})`);
      return [];
    }
  }

  async function projectRoots(): Promise<{ dirs: string[]; source: ProjectRootSource }> {
    if (fixed.length) return { dirs: fixed, source: "arguments" };
    clientRoots ??= listClientRoots();
    const fromClient = await clientRoots;
    if (fromClient.length) return { dirs: fromClient, source: "client" };
    const real = await realDirectory(cwd);
    if (!real) throw new ConfigError(`the server's working directory ${cwd} does not exist`);
    return { dirs: [real], source: "cwd" };
  }

  /** The directory to search for one call, inside the allowed project roots. */
  async function searchDirectory(directory: string | undefined): Promise<string> {
    const roots = await projectRoots();
    let target = roots.dirs[0]!;
    if (directory !== undefined) {
      const candidates = isAbsolute(directory) ? [directory] : roots.dirs.map((d) => resolve(d, directory));
      let found: string | null = null;
      let file = false;
      for (const candidate of candidates) {
        let real: string;
        try {
          real = await realpath(candidate);
        } catch {
          continue;
        }
        if (!(await stat(real)).isDirectory()) {
          file = true;
          continue;
        }
        found = real;
        break;
      }
      if (!found) {
        throw new CodeSearchArgumentError(
          file
            ? `directory "${directory}" is a file; pass the directory that contains it and put the file in paths`
            : `directory "${directory}" does not exist`,
        );
      }
      if (!roots.dirs.some((d) => inside(d, found))) {
        throw new CodeSearchArgumentError(
          `directory "${directory}" is outside the project directories this server may search (${roots.dirs.join(", ")})`,
        );
      }
      target = found;
    }
    if (roots.source === "cwd") {
      const realHome = (await realDirectory(home)) ?? home;
      if (target === realHome || parse(target).root === target) {
        throw new CodeSearchArgumentError(
          `the server does not know which project to search: it was started in ${target} and the client reported ` +
            "no workspace roots. Pass directory with the absolute project path, or start the server as " +
            "`ggr mcp <project directory>`",
        );
      }
    }
    return target;
  }

  async function codeSearch(args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    let lease: JevCircuitLease | null = null;
    try {
      const { directory, rest } = takeDirectory(args);
      const request = parseArguments(rest);
      const settings = await loadSettings(env);
      if (!settings.apiKey) {
        throw new ConfigError(
          `genigrep has no Jev API key; ask the user to run \`ggr auth\` in a terminal or set ${ENV_API_KEY} in this MCP server's environment`,
        );
      }
      const rg = findRipgrep(env);
      if (!rg) throw new CodeSearchRipgrepMissingError("ripgrep (rg) was not found");
      const root = await searchDirectory(directory);
      lease = breaker.tryAcquire(Date.now());
      if (!lease) {
        return textResult(
          renderFailure(new JevUnavailableError("Jev is not responding; calls are paused for a few minutes")),
          true,
        );
      }
      const result = await genigrep({
        ...request,
        root,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
        signal,
        headerName: CODE_SEARCH_TOOL_NAME,
        workspace: { rgPath: rg.path },
        fetch: options.fetch,
      });
      const held = lease;
      lease = null;
      // A pack whose final status check hit an outage still counts against Jev.
      if (result.statusCheckError instanceof JevUnavailableError) {
        breaker.recordFailure(result.statusCheckError, Date.now(), held);
      } else if (result.stats.jev.requests > 0) {
        breaker.recordSuccess(held);
      } else {
        breaker.release(held);
      }
      const s = result.stats;
      log(
        `ggr mcp: code_search ${result.passages.length} passages | ${(s.wallMs / 1000).toFixed(1)}s | ` +
          `jev ${s.jev.requests} requests, ${s.jev.inputTokens} input tokens, $${s.jev.costUsd.toFixed(4)}`,
      );
      const text = result.text.endsWith("\n") ? result.text : `${result.text}\n`;
      return textResult(`${text}Paths are relative to ${result.root}.`, false);
    } catch (error) {
      if (signal.aborted) return textResult("code_search was cancelled.", true);
      if (error instanceof JevUnavailableError) {
        const held = lease;
        lease = null;
        breaker.recordFailure(error, Date.now(), held);
      } else if (!(error instanceof CodeSearchArgumentError || error instanceof ConfigError)) {
        log(`ggr mcp: code_search failed: ${oneLine(error instanceof Error ? error.message : String(error))}`);
      }
      return textResult(renderFailure(error), true);
    } finally {
      if (lease) breaker.release(lease);
    }
  }

  server.setRequestHandler("tools/list", async () => ({ tools: [MCP_TOOL] }));

  server.setRequestHandler("tools/call", async (params, context) => {
    if (params.name !== CODE_SEARCH_TOOL_NAME) {
      throw new McpError(McpErrorCode.InvalidParams, `Unknown tool: ${String(params.name)}`);
    }
    const args = params.arguments ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new McpError(McpErrorCode.InvalidParams, "arguments must be an object");
    }
    // Cancelled by the client (notifications/cancelled) or by the server shutting down.
    const { signal, dispose } = combineSignals(context.signal, options.signal);
    try {
      return await codeSearch(args as Record<string, unknown>, signal);
    } finally {
      dispose();
    }
  });

  return server;
}

/** Aborts when either signal does; dispose() detaches from the long-lived one. (AbortSignal.any needs Node 20.3.) */
function combineSignals(
  request: AbortSignal,
  shutdown: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
  if (!shutdown) return { signal: request, dispose: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (request.aborted || shutdown.aborted) abort();
  request.addEventListener("abort", abort, { once: true });
  shutdown.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      request.removeEventListener("abort", abort);
      shutdown.removeEventListener("abort", abort);
    },
  };
}
