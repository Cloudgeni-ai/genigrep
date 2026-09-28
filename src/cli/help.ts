export const SEARCH_HELP = `genigrep - ask a question about a codebase, get back only the source that answers it

Usage:
  genigrep "<question>" [path] [options]
  genigrep auth [--no-verify | --remove | --status]
  genigrep doctor [--json]
  genigrep mcp [dir ...]
  genigrep --version

Search:
  path is the directory to search (default: the current directory); output paths are relative to it.
  The answer is an evidence pack: verbatim, line-numbered passages with their paths, best first, then
  leads the search did not follow. A one-line cost and time summary goes to stderr.

Options:
  -k, --keyword <kw>    A likely identifier, file-name fragment, config key, error string or synonym.
                        Repeat it or separate with commas; 6-15 work best. Case and camel/snake/kebab
                        variants are searched automatically. Derived from the question when omitted.
  -s, --sub <question>  One distinct part of a multi-part question (repeatable, up to 3).
      --in <path>       Search this file or directory first, relative to the searched directory
                        (repeatable, up to 8). When fewer than 5 files match there, the whole
                        directory is searched and the output says so.
  -b, --budget <n>      Max size of the evidence pack in tokens (default 12000, 1000-100000).
      --json            Print one JSON object (passages, leads, status, stats) instead of text.
  -v, --verbose         Also print keywords, stage timings and counts to stderr.
  -q, --quiet           Do not print the cost and time summary.
  -h, --help            Show help (also: genigrep help auth, genigrep help doctor, genigrep help mcp).
  -V, --version         Show the version.

Read the passages instead of re-opening those files. The evidence rating in the first line covers only
the passages returned; it cannot see what the search missed, so check what they do not cover (other entry
points, defaults, flags, exceptions) before concluding.

Environment:
  GENIGREP_JEV_API_KEY      TypeSafe Jev API key (overrides the stored key)
  GENIGREP_JEV_BASE_URL     Jev endpoint (default https://api.typesafe.ai)
  GENIGREP_JEV_MODEL        Jev model (default jev-latest)
  GENIGREP_JEV_TIMEOUT_MS   Jev per-request timeout (default 10000)
  GENIGREP_RG_PATH          ripgrep binary to use instead of the bundled one or rg on PATH

Exit codes:
  0  passages found            3  setup problem (no key, no ripgrep, missing directory)
  1  no passage verified       4  Jev failed (unreachable, key or billing rejected)
  2  invalid arguments         5  search failed for another reason
  130 interrupted

Examples:
  genigrep "Where is the usage limit error classified?" -k usageLimit,rate_limit,429,classifyError
  genigrep "How is the retry delay computed?" ./services/api --in src -s "What caps the delay?"
  genigrep "Which env vars configure the database?" --json | jq '.passages[].path'
`;

export const AUTH_HELP = `Usage:
  genigrep auth               Store a TypeSafe Jev API key (prompted without echo, or read from stdin)
  genigrep auth --no-verify   Store it without the test call to Jev
  genigrep auth --status      Show where the key comes from (the key itself is never printed)
  genigrep auth --remove      Delete the stored key

The key is stored in $XDG_CONFIG_HOME/genigrep/config.json (default ~/.config/genigrep/config.json;
%APPDATA%\\genigrep\\config.json on Windows) with mode 600. GENIGREP_JEV_API_KEY overrides it.

  printf '%s' "$KEY" | genigrep auth
`;

export const DOCTOR_HELP = `Usage:
  genigrep doctor [--json]

Checks the runtime, finds ripgrep and runs it on a probe file, reads the config, and makes one tiny Jev
call with the configured key (about 300 input tokens). Exits 0 when everything works,
3 for a setup problem and 4 when the Jev call fails.
`;

export const MCP_HELP = `Usage:
  genigrep mcp [dir ...] [-q]

Runs a Model Context Protocol server on stdin/stdout with one tool, code_search, for coding agents
(Claude Code, Codex, Cursor and others). It searches the given directories; without any, the workspace
roots the client reports, else the directory the server was started in. A call may pick another directory
inside those with its directory argument.

The server uses the same API key and settings as the command line (genigrep auth, GENIGREP_JEV_API_KEY).
Setup problems are reported to the agent on each call, so it can fall back to rg.

  -q, --quiet   Do not log to stderr.

Examples:
  claude mcp add genigrep -- genigrep mcp
  codex mcp add genigrep -- genigrep mcp
`;
