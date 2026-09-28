# Changelog

## 0.1.0 (2026-09-28)

First version, ported from OpenGeni's `code_search` agent tool (`packages/jev`).

- The code search engine (scout-0.3.1 ranking with TypeSafe Jev as the judge), unchanged in ranking,
  thresholds and defaults. Additions: structured `passages` and `leads` in the result, and an optional
  `headerName` for the status line.
- `LocalWorkspace`: ripgrep (bundled through `@vscode/ripgrep`, or `rg` on PATH) and bounded file reads
  over a local directory, honouring `.gitignore`, skipping binaries, dependency directories and secret
  files.
- The `ggr` command line (also installed as `genigrep`): search, `auth`, `doctor`, `--json`, documented exit codes.
- Keywords derived from the question when none are given.
- `ggr mcp`: a stdio MCP server with one `code_search` tool (OpenGeni's schema plus `directory`),
  OpenGeni's tool wording and code search instruction, one Jev circuit breaker per server, and searches
  limited to the directories given, the client's roots or the working directory.
- An Agent Skill in `skills/genigrep` for Claude Code, Codex and other agents.
- A credentials directory (`.ssh`, `.aws`, `.gnupg`, `.kube`) is never searched as the root.
- Secret files are matched regardless of case, a few more are covered (more `.env.*` variants,
  `*.tfvars.json`, `*.p8`, `.vault-token`, `.s3cfg`, `.boto`, `.dockercfg`, the GitHub CLI's `hosts.yml`,
  Cargo and RubyGems credentials), and a link named explicitly is checked by its target.
- The MCP server has no runtime dependency (it implements the protocol subset it needs), so the only
  runtime dependency is `@vscode/ripgrep`.
- The bundled ripgrep is also found under pnpm's strict `node_modules` layout.
- Documentation: README, `docs/how-it-works.md` (pipeline, limits, output, what is sent to Jev, MCP
  server), security policy, contributing guide and GitHub issue templates.
