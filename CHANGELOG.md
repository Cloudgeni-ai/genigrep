# Changelog

## 0.1.0 (unreleased)

First version, ported from OpenGeni's `code_search` agent tool (`packages/jev`).

- The code search engine (scout-0.3.1 ranking with TypeSafe Jev as the judge), unchanged in ranking,
  thresholds and defaults. Additions: structured `passages` and `leads` in the result, and an optional
  `headerName` for the status line.
- `LocalWorkspace`: ripgrep (bundled through `@vscode/ripgrep`, or `rg` on PATH) and bounded file reads
  over a local directory, honouring `.gitignore`, skipping binaries, dependency directories and secret
  files.
- The `genigrep` command line: search, `auth`, `doctor`, `--json`, documented exit codes.
- Keywords derived from the question when none are given.
- `genigrep mcp`: a stdio MCP server with one `code_search` tool (OpenGeni's schema plus `directory`),
  OpenGeni's tool wording and code search instruction, one Jev circuit breaker per server, and searches
  limited to the directories given, the client's roots or the working directory.
- An Agent Skill in `skills/genigrep` for Claude Code, Codex and other agents.
- A credentials directory (`.ssh`, `.aws`, `.gnupg`, `.kube`) is never searched as the root.
