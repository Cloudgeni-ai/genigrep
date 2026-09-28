# genigrep

Ask a question about a codebase, get back only the source that answers it.

[![CI](https://github.com/Cloudgeni-ai/genigrep/actions/workflows/ci.yml/badge.svg)](https://github.com/Cloudgeni-ai/genigrep/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

genigrep is code search for coding agents, and for people. You give it a question and a few likely
keywords. It finds candidate files with ripgrep, has a small and cheap judge model rank the files and
check the passages, and prints the passages that answer the question, verbatim with paths and line
numbers.

It runs as a command line tool, an [MCP server](#mcp-server) and a library, and comes with an
[agent skill](#agent-skill).

## Why

A coding agent that needs to know "where is X decided?" usually loops: search, read a file, search
again, read another file. Every step is a call to an expensive model that re-reads the whole
conversation. genigrep does the search in one call. A cheap judge model, TypeSafe Jev, decides which
files and passages are relevant, and genigrep returns only those. The agent still does the reasoning;
it just starts from the right code.

On 26 code investigation questions, inside the OpenGeni agent harness, this cut the agent's cost by
about 7% and its time by about 10% at equal answer quality. It had no measurable effect on bug-fixing
tasks. See [Measured results](#measured-results).

## Install

Requires Node.js 20 or newer, or Bun. Tested on Linux and macOS.

```bash
npm install -g @opengeni/genigrep
```

ripgrep comes with it through the [`@vscode/ripgrep`](https://github.com/microsoft/vscode-ripgrep)
package. If that binary is missing, genigrep uses `rg` from your PATH. `GENIGREP_RG_PATH` picks a
specific binary.

From source:

```bash
git clone https://github.com/Cloudgeni-ai/genigrep.git && cd genigrep
bun install && bun run build && npm link
```

## Quick start

1. Get a TypeSafe API key with Jev access from [TypeSafe](https://typesafe.ai), which also lists pricing.
2. Store it. genigrep asks for it without echoing, checks it with one small Jev call and saves it with
   mode `600`:

   ```bash
   genigrep auth
   ```

   Or set `GENIGREP_JEV_API_KEY` in the environment instead.
3. Ask a question about the current directory:

   ```bash
   genigrep "How is the retry delay computed?" .
   ```

Without `-k`, genigrep derives keywords from the question. Results are better when you name likely
identifiers, config keys and error strings yourself:

```bash
genigrep "How is the retry delay computed?" -k retryDelay,backoff,RETRY_MAX,retry-after,maxDelay
```

`genigrep doctor` checks ripgrep, the config and the key if something does not work.

Example, run against the public OpenGeni repository (`...` marks lines cut here):

```console
$ genigrep "Where is the Codex usage limit error classified?" \
    -k usage_limit_reached,CODEX_USAGE_LIMIT_ERROR_TYPE,classifyCodexUsageLimitError,usageLimit,resets_in_seconds,429,quota,rateLimit
genigrep: evidence rating 0.94 | 15 passages from 10 files, ~10.5k tokens | 2.3s
Passages are verbatim with original line numbers (N| text), grouped by file, best first; rel = relevance, [sN] = covers sub-question N. The rating covers only these passages; it cannot see other entry points, defaults, flags or exceptions the search did not return.

== packages/codex/src/fetch.ts:893-943  rel 0.96
...
902| /** The codex backend's hard-cap error type (ChatGPT/Codex usage limit reached). */
903| export const CODEX_USAGE_LIMIT_ERROR_TYPE = "usage_limit_reached";
...
918| export function classifyCodexUsageLimitError(error: unknown): CodexUsageLimitInfo | null {
...

More candidates (not included; read if needed):
  apps/worker/src/activities/agent-turn/errors.ts:1434-1498 (0.49), ...
Leads not followed: CodexAccountStatus (0.48) @apps/worker/src/activities/agent-turn/errors.ts:1320, ...
```

This goes to stdout. A one-line summary with the number of Jev requests and the time taken goes to
stderr.

## Usage

```text
genigrep "<question>" [path] [options]
genigrep auth [--no-verify | --remove | --status]
genigrep doctor [--json]
genigrep mcp [dir ...]
genigrep --version
```

`path` is the directory to search (default: the current directory). Paths in the output are relative
to it.

| Option | Meaning |
| --- | --- |
| `-k, --keyword <kw>` | A likely identifier, file-name fragment, config key, error string or synonym. Repeat it or separate with commas; 6-15 work best. camelCase, snake_case and kebab-case variants are searched automatically. |
| `-s, --sub <question>` | One distinct part of a multi-part question (up to 3). For "is X required?", add one for what could skip or override X. |
| `--in <path>` | Search this file or directory first (up to 8). If fewer than 5 files match there, the whole directory is searched and the output says so. |
| `-b, --budget <n>` | Maximum size of the output in tokens (default 12000). |
| `--json` | Print one JSON object instead of text. |
| `-v, --verbose` | Also print keywords, stage timings and counts to stderr. |
| `-q, --quiet` | Do not print the summary line on stderr. |

| Exit code | Meaning |
| --- | --- |
| 0 | At least one passage found. |
| 1 | No passage passed verification. |
| 2 | Invalid arguments. |
| 3 | Setup problem: no API key, no ripgrep, missing directory. |
| 4 | Jev failed: unreachable, timed out, or key or billing rejected. |
| 5 | Another failure. |
| 130 | Interrupted. |

The output format and the JSON fields are described in [docs/how-it-works.md](docs/how-it-works.md#output).

## Agent setup

There are three ways to give an agent genigrep, and they can be combined:

- **Agent skill.** Teaches the agent when to run `genigrep`, when to use `rg` instead, and how to read
  the results. For agents that run shell commands and read Agent Skills.
- **MCP server.** `genigrep mcp` gives the agent a `code_search` tool.
- **Instructions snippet.** A paragraph for `AGENTS.md`, `CLAUDE.md` or a system prompt.

All three reuse the wording OpenGeni ships with the tool. An earlier wording made agents trust the
search too much, and their answers got worse. One sentence fixed it: the evidence rating cannot see
what the search missed. Keep that meaning if you adapt the text.

Keywords matter. The evaluation used keywords chosen by the agent, so the skill and the MCP tool ask
the agent for them.

### Agent skill

[`skills/genigrep/SKILL.md`](skills/genigrep/SKILL.md) ships in the npm package. Copy it into your
agent's skills directory:

```bash
SKILL="$(npm root -g)/@opengeni/genigrep/skills/genigrep"
cp -r "$SKILL" ~/.claude/skills/     # Claude Code, all projects (or <project>/.claude/skills/)
cp -r "$SKILL" ~/.agents/skills/     # Codex, all projects (or <project>/.agents/skills/)
```

Or install it with the [skills](https://github.com/vercel-labs/skills) installer, which detects your
agents:

```bash
npx skills add Cloudgeni-ai/genigrep
```

The skill runs the `genigrep` command, so install genigrep and store a key first.

### MCP server

`genigrep mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio with
one read-only tool, `code_search`. It takes a question, keywords, optional sub-questions, optional
paths and an optional directory. It reads the key stored by `genigrep auth` on every call, so no key
goes into the client's configuration.

**Claude Code**

```bash
claude mcp add --scope user genigrep -- genigrep mcp
```

Or, for one project, in `.mcp.json`:

```json
{
  "mcpServers": {
    "genigrep": { "command": "genigrep", "args": ["mcp"] }
  }
}
```

**Codex**

```bash
codex mcp add genigrep -- genigrep mcp
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.genigrep]
command = "genigrep"
args = ["mcp"]
# Only if the key comes from the environment instead of `genigrep auth`:
# env_vars = ["GENIGREP_JEV_API_KEY"]
```

**Cursor**, in `~/.cursor/mcp.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "genigrep": { "command": "genigrep", "args": ["mcp"] }
  }
}
```

Other clients: run `genigrep mcp` as a stdio server. `npx -y @opengeni/genigrep mcp` works without a global
install.

The server searches the directories given on its command line (`genigrep mcp ~/src/app`), otherwise
the workspace roots the client reports, otherwise the directory it was started in. In that last case
it will not search the home directory or the filesystem root. A tool call cannot leave these
directories, and a credentials directory such as `~/.aws` is never searched. Details:
[docs/how-it-works.md](docs/how-it-works.md#mcp-server).

### Instructions snippet

For agents without skills or MCP:

```markdown
## Code search

To find where something is implemented, configured or decided in this repository, run
`genigrep "<one precise question>" -k <keywords>` instead of many separate searches and file reads.
Give 6-15 keywords: likely identifiers, file-name fragments, config keys, error strings and synonyms
(comma-separated). Optional `-s "<part>"` flags split distinct parts of the question (for "is X
required?", add one for what could skip or override X); optional `--in <dir>` limits the search.
It ranks files and passages with a fast relevance model, follows definitions one level, and returns the
best passages verbatim with file paths and line numbers, plus an evidence rating for those passages.
The rating cannot see what the search missed: use the passages instead of re-reading them, then check
what they do not cover (other entry points, defaults, flags, exceptions) before concluding.
If genigrep exits with 3 or 4, search with rg instead.
```

## How it works

1. **Keyword pass.** One ripgrep pass finds every file that matches a keyword or one of its
   camelCase, snake_case and kebab-case variants. Files are scored by how rare the matched keywords
   are. Up to 240 of the best become candidates.
2. **File triage.** Jev judges each candidate from its path and its three best matching lines.
3. **Passage check.** genigrep cuts the chosen files into line-numbered passages around the matches,
   aligned to the enclosing function or section, and Jev scores each passage for relevance and for
   each sub-question.
4. **Leads.** Identifiers used in the best passages are scored, and genigrep follows up to six of
   their definitions, one level deep.
5. **Pack.** The passages that pass are packed into the token budget, best first. One last Jev call
   rates how well they answer the question.

Jev requests within a stage run in parallel, so a search takes a few seconds. The output is the
passages verbatim, the leads that were not followed, and the evidence rating. Jev only scores; it
never writes text. The agent reads the passages and does the reasoning.

More detail, including every limit and threshold: [docs/how-it-works.md](docs/how-it-works.md).

## Measured results

The engine was evaluated as OpenGeni's `code_search` tool, inside the OpenGeni agent harness. The
command line tool, MCP server, skill and derived keywords in this repository were not part of the
evaluation.

Setup: 26 real questions about the OpenGeni codebase (a TypeScript monorepo), answered by the
agent with and without the tool, graded by two blind graders. The comparison is paired per question.
Brackets are 95% paired bootstrap confidence intervals over the questions.

| Run | Agent model | Cost | Time | Other |
| --- | --- | --- | --- | --- |
| 1 | `gpt-6-astra` | -6.6% [-11.5, -1.9] | -9.1% [-13.4, -4.6] | |
| 2 | `gpt-6-sol`, xhigh reasoning | -7.5% [-14.2, +0.4] | -9.8% [-17.9, +0.6] | Model calls per question 19.4 to 16.2. Pass rate +1.9 points [-4.8, +8.7]. |

Answer quality was equal with and without the tool. Run 2's intervals include zero: it agrees with
run 1 but does not confirm it on its own.

Other results:

- **Without Jev.** The same pipeline with keyword-only ranking lost 7.7 points of answer quality. That
  is why genigrep fails instead of falling back to keyword ranking when Jev is unavailable.
- **Bug fixing.** On Terminal-Bench 2.1 and SWE-rebench (12 tasks each, one trial) there was no
  measurable effect.

Limits: one repository in one language, 26 questions, one agent harness, and a small bug-fixing
sample. Other codebases, languages and agents may behave differently.

> **Methodology:** the evaluation is described in OpenGeni's [code search documentation](https://github.com/Cloudgeni-ai/opengeni/blob/main/docs/code-search.md).

## Privacy

**What is sent to Jev.** genigrep does not upload your repository. Jev receives only what it needs to
judge:

- the question and sub-questions;
- the paths of up to 240 candidate files, each with up to 3 matching lines;
- up to 80 passages being checked, plus up to 6 followed definitions, each at most 8,000 characters;
- up to 60 identifier names with the line they appear on;
- up to 60,000 characters of the final packed passages, for the rating.

Requests go to `https://api.typesafe.ai` over HTTPS, and the key is sent only in the `Authorization`
header. Exact limits are in [docs/how-it-works.md](docs/how-it-works.md#what-is-sent-to-jev).

**What is never read.** Files excluded by `.gitignore` (also outside a git repository), `.ignore` and
`.rgignore`; binary files; dependency, build and cache directories (`node_modules`, `dist`, `target`,
`vendor`, `.venv` and more); lock files and minified or generated files; and common secret files
(`.env` and its variants, private keys, `*.tfvars`, `*.tfstate`, `.npmrc`, `.netrc`, credential JSON
files, `.ssh/`, `.aws/` and others), matched regardless of case. A secret file is skipped even when you
name it or a link to it. `.env.example` stays searchable.

genigrep does not scan file contents for secrets. A credential hard-coded in an ordinary source file
can be sent as part of a passage. See [SECURITY.md](SECURITY.md).

## Configuration

| Setting | Environment variable | Config file key | Default |
| --- | --- | --- | --- |
| API key | `GENIGREP_JEV_API_KEY` | set by `genigrep auth` | none |
| Jev endpoint | `GENIGREP_JEV_BASE_URL` | `jevBaseUrl` | `https://api.typesafe.ai` |
| Jev model | `GENIGREP_JEV_MODEL` | `jevModel` | `jev-latest` |
| Jev request timeout (ms) | `GENIGREP_JEV_TIMEOUT_MS` | | `10000` |
| ripgrep binary | `GENIGREP_RG_PATH` | | bundled, then `rg` on PATH |

Environment variables override the config file. The config file is
`$XDG_CONFIG_HOME/genigrep/config.json` (default `~/.config/genigrep/config.json`,
`%APPDATA%\genigrep\config.json` on Windows), created with mode `600` in a `700` directory. The key is
never printed or logged; `genigrep auth --status` shows where it comes from, not what it is. The
endpoint must use HTTPS, except for `localhost`.

To exclude more paths, list them in a `.ignore` or `.rgignore` file (gitignore syntax).

## Limitations

- **Investigation, not bug fixing.** The gains were measured on questions about how code works. On
  bug-fixing tasks there was no measurable gain.
- **A Jev key is required.** There is no offline or keyword-only mode. If Jev is unavailable, genigrep
  exits with code 4 (the MCP tool returns an error) and the agent should use `rg`.
- **Languages.** Tuned and evaluated on one TypeScript repository. Passages are aligned to
  declarations in TypeScript and JavaScript, Rust, Go, Python, Markdown, SQL and YAML; other languages
  get a fixed amount of context around each match. Search quality on other languages has not been
  measured.
- **Not exhaustive.** genigrep returns the best passages, not every occurrence. Use `rg` for renames
  and for counting call sites.
- **Keywords.** Keywords derived from the question are a convenience for people and were not
  evaluated. Keywords chosen by the agent work better.
- **Windows** is not tested yet.

## Library

```ts
import { genigrep } from "@opengeni/genigrep";

const result = await genigrep({
  question: "How is the retry delay computed?",
  keywords: ["retryDelay", "backoff", "RETRY_MAX"],
  root: "/path/to/repo",
  apiKey: process.env.GENIGREP_JEV_API_KEY!,
});
console.log(result.text); // the rendered output
for (const p of result.passages) console.log(p.path, p.start, p.end, p.rel);
```

The package also exports the engine (`runCodeSearch`, `JevClient`, `JevCircuitBreaker`), the tool
definition and wording (`CODE_SEARCH_TOOL_DESCRIPTION`, `CODE_SEARCH_DIRECTIVE`,
`codeSearchInputSchema`), the `LocalWorkspace` adapter, and the `CodeSearchWorkspace` interface for
searching somewhere other than the local disk.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in
[SECURITY.md](SECURITY.md).

## Origin

genigrep was extracted from [OpenGeni](https://github.com/Cloudgeni-ai/opengeni), where the same
engine runs as the `code_search` agent tool. The engine in `src/engine` is a port of OpenGeni's
`packages/jev`, with ranking, thresholds and Jev prompts unchanged. [NOTICE](NOTICE) names the exact
source commit.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution. ripgrep is by Andrew Gallant and
contributors (MIT or Unlicense); `@vscode/ripgrep` is by Microsoft (MIT).
