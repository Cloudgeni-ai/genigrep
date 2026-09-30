# Changelog

## 0.2.0 (unreleased)

The engine is now scout-0.4, ported from OpenGeni's `code_search` (`packages/jev`). Recall, triage and
passage-check defaults are unchanged; the new stages let an agent read less irrelevant code without
missing relevant code. On 138 real OpenGeni searches replayed at their own commits, the share of the
regions agents later edited or cited that the output contains or points to rose from 29% to 57%;
output grew from 8.8k to 10.6k tokens.

- Symbol discovery: Jev judges the identifiers the relevant files declare, import, call or render, and
  one ripgrep pass finds the definitions and usages of the chosen ones, so the file behind an import or
  a sibling call site is found even when no keyword matched it.
- The most relevant small files are cut into declaration-sized tiles, so every function in them is
  judged, and a "must change together" judgment adds sibling functions of the top files.
- Followed leads also bring up to 3 call sites each.
- The pack shows small relevant files whole, joins nearby passages, ranks import-only spans lower and
  puts each sub-question's best passage first. A low evidence rating follows more leads once; a
  middling one fills the rest of the budget with the next-best passages.
- The output ends with what it did not show: the relevant files with their not-shown line ranges and
  the functions declared there, every limit that cut something, and keywords that matched nothing or
  only irrelevant files, with similar identifiers that exist in the workspace. The header tells the
  reader to read the not-shown ranges before changing code.
- Structured result: `leads` gains `coverage`, `cuts`, `irrelevantKeywords` and `note`; keyword
  entries gain `suggestions` and `files`; `morePassages` and `moreFiles` leave out files already in
  `coverage`, as the text does. Passages gain `uses`, `changeTogether` and `wholeFile`.
- `.opengeni/` directories (OpenGeni sandbox state) are never searched. A `--in` path inside `.git` or
  `.opengeni` is ignored and reported as not found.
- More is sent to Jev per search (identifier shortlists, function signatures, up to 200 passages);
  Jev cost per search rises by about 80%. See `docs/how-it-works.md`.
- The skill and CLI help describe the new footer. The MCP tool description and code search
  instruction are unchanged.

## 0.1.1 (2026-09-28)

- README: fix the `npx` MCP command (`npx -y @opengeni/genigrep mcp`).

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
