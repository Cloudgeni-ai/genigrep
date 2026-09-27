/** `genigrep mcp`: the MCP server on stdin/stdout. Diagnostics go to stderr; stdout carries only protocol messages. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadSettings } from "../config";
import { EXIT, type McpCommand } from "../cli/args";
import type { CliIo } from "../cli/main";
import { findRipgrep } from "../ripgrep";
import { createGenigrepMcpServer, resolveServerDirectories } from "./server";

export async function serveMcp(command: McpCommand, io: CliIo): Promise<number> {
  let directories: string[];
  try {
    directories = await resolveServerDirectories(command.directories, io.cwd);
  } catch (error) {
    io.stderr(`genigrep mcp: ${error instanceof ConfigError ? error.message : String(error)}\n`);
    return EXIT.SETUP;
  }
  const log = (line: string) => {
    if (!command.quiet) io.stderr(`${line}\n`);
  };

  // Setup problems do not stop the server: the tool reports them to the agent on each call, and fixing the
  // setup (genigrep auth) takes effect without restarting the client.
  try {
    const settings = await loadSettings(io.env);
    for (const w of settings.warnings) log(`genigrep mcp: warning: ${w}`);
    if (!settings.apiKey) log("genigrep mcp: warning: no Jev API key; run `genigrep auth` (code_search calls fail until then)");
  } catch (error) {
    log(`genigrep mcp: warning: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!findRipgrep(io.env)) log("genigrep mcp: warning: ripgrep (rg) was not found; install it or set GENIGREP_RG_PATH");

  const shutdown = new AbortController();
  const server = createGenigrepMcpServer({
    directories,
    env: io.env,
    cwd: io.cwd,
    log,
    signal: shutdown.signal,
    fetch: io.fetch,
  });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  const close = () => {
    shutdown.abort();
    void server.close();
  };
  // The client ends the session by closing our stdin.
  process.stdin.once("end", close);
  process.stdin.once("close", close);
  io.signal?.addEventListener("abort", close, { once: true });

  await server.connect(transport);
  log(
    `genigrep mcp ready: code_search over ${
      directories.length ? directories.join(", ") : "the client's workspace roots (else the current directory)"
    }`,
  );
  await closed;
  return EXIT.OK;
}
