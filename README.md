# genigrep

Ask a question about a codebase, get back only the source that answers it. Jev-ranked code search for
coding agents.

[![CI](https://github.com/Cloudgeni-ai/genigrep/actions/workflows/ci.yml/badge.svg)](https://github.com/Cloudgeni-ai/genigrep/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

genigrep runs one wide ripgrep pass for your keywords, has [TypeSafe Jev](https://typesafe.ai) (a fast
judge model) rank the candidate files and verify line-numbered passages, follows definitions one level,
and prints the best passages verbatim with their paths and line numbers. One call replaces the usual
loop of `rg`, `sed -n`, `cat` and "let me look at that file too", so an agent spends fewer turns and
tokens getting to the code that matters.

It is the `code_search` tool from [OpenGeni](https://github.com/Cloudgeni-ai/opengeni), packaged as a
standalone command line tool, an [MCP server](#mcp-server) and a library, with an
[agent skill](#agent-skill) that teaches coding agents when to use it.

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
919|   let cur: unknown = error;
920|   for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
...

== docs/codex-subscription-rotation.md:467-504  rel 0.93  (trimmed from 456-504)
   in L210: ### Same-turn capacity recovery
...

More candidates (not included; read if needed):
  apps/worker/src/activities/agent-turn/errors.ts:1434-1498 (0.49), ...
Leads not followed: CodexAccountStatus (0.48) @apps/worker/src/activities/agent-turn/errors.ts:1320, ...
genigrep: 15 passages from 10 files, ~10.5k tokens | 2.3s | jev 17 requests, 91.3k input tokens, $0.0038
```

(Run against the public OpenGeni repository; `...` marks lines cut from this README.)

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Using genigrep from a coding agent](#using-genigrep-from-a-coding-agent)
  - [Agent skill](#agent-skill)
  - [MCP server](#mcp-server)
  - [Instructions snippet](#instructions-snippet)
- [How it works](#how-it-works)
- [What is sent to Jev](#what-is-sent-to-jev)
- [Cost and speed](#cost-and-speed)
- [Evidence](#evidence)
- [Configuration](#configuration)
- [Library](#library)
- [Development](#development)
- [Origin and license](#origin-and-license)

## Install

Requires Node.js 20 or newer (Bun works too). Linux and macOS are tested; Windows is not tested yet.

genigrep is not on npm yet. Until it is, build it from source:

```bash
git clone https://github.com/Cloudgeni-ai/genigrep.git
cd genigrep
bun install && bun run build
npm link            # puts `genigrep` on your PATH
```

Once published, it will be:

```bash
npm install -g genigrep
```

ripgrep comes with it: the [`@vscode/ripgrep`](https://github.com/microsoft/vscode-ripgrep) package
installs a prebuilt `rg` for your platform. If that binary is missing, genigrep uses `rg` from your
PATH, and `GENIGREP_RG_PATH` picks a specific binary.

## Quick start

1. Get a TypeSafe API key with Jev access from [TypeSafe](https://typesafe.ai).
2. Store it. genigrep asks for it without echoing it, checks it with one tiny Jev call and saves it
   with mode `600`:

   ```bash
   genigrep auth
   # or non-interactively:
   printf '%s' "$KEY" | genigrep auth
   ```

   Or skip storing it and set `GENIGREP_JEV_API_KEY` in the environment.
3. Check the setup:

   ```bash
   genigrep doctor
   ```

4. Ask a question from inside a repository:

   ```bash
   genigrep "How is the retry delay computed?" -k retryDelay,backoff,RETRY_MAX,retry-after
   ```

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
| `-k, --keyword <kw>` | A likely identifier, file-name fragment, config key, error string or synonym. Repeat it or separate with commas; 6-15 work best. Case and camelCase, snake_case and kebab-case variants are searched automatically. When omitted, keywords are derived from the question. |
| `-s, --sub <question>` | One distinct part of a multi-part question (up to 3). For "is X required?", add one for what could skip or override X. |
| `--in <path>` | Search this file or directory first, relative to the searched directory (up to 8). When fewer than 5 files match there, the whole directory is searched and the output says so. |
| `-b, --budget <n>` | Max size of the evidence pack in tokens (default 12000). |
| `--json` | One JSON object on stdout instead of text. |
| `-v, --verbose` | Also print keywords, stage timings and counts to stderr. |
| `-q, --quiet` | Do not print the summary line on stderr. |

### Output

stdout carries the evidence pack, in this order:

1. A status line: the evidence rating (Jev's estimate that the returned passages answer the question,
   per sub-question too), the number of passages and files, the pack size and the time.
2. The passages, verbatim, each headed `== path:start-end  rel 0.96`, with `[s1]` when a passage
   covers sub-question 1, `(definition of X)` for definitions followed from a lead, and
   `in L210: ...` naming the enclosing declaration when a passage starts inside one.
3. Leads: verified passages that did not fit, other candidate files, identifiers whose definitions were
   not followed, and keywords with no hits.

stderr carries one summary line with the Jev requests, input tokens and cost, for example
`genigrep: 15 passages from 10 files, ~10.5k tokens | 2.3s | jev 17 requests, 91.3k input tokens, $0.0038`.

`--json` prints `{ genigrep, engine, root, question, keywords, keywordsDerived, subQuestions, paths,
status, passages, leads, stats, text }`. Each passage is `{ path, start, end, rel, coverage, kind,
lines }` plus `definitionOf`, `trimmedFrom` and `enclosing` when they apply; `text` is the rendered pack.
On failure, `--json` prints `{ "error": { "kind", "message" } }` instead.

```bash
genigrep "Which env vars configure the database?" --json | jq -r '.passages[] | "\(.path):\(.start)"'
```

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The evidence pack has at least one passage (other commands: success). |
| 1 | No passage passed verification (like grep finding nothing). |
| 2 | Invalid arguments. |
| 3 | Setup problem: no API key, no ripgrep, unreadable config, missing directory. |
| 4 | Jev failed: unreachable, timed out, key or billing rejected, request rejected. |
| 5 | The search failed for another reason. |
| 130 | Interrupted. |

genigrep does not fall back to keyword-only ranking when Jev fails: in the evaluation that lowered
answer quality. Use `rg` directly in that case.

## Using genigrep from a coding agent

There are three ways to give an agent genigrep. They can be combined.

- **Agent skill.** Teaches the agent when to run `genigrep`, when to use `rg` instead, and how to read
  the results. Works with any agent that can run shell commands and reads Agent Skills.
- **MCP server.** `genigrep mcp` gives the agent a `code_search` tool, for agents that speak the Model
  Context Protocol.
- **Instructions snippet.** A paragraph for `AGENTS.md`, `CLAUDE.md` or a system prompt.

All three are built from the wording OpenGeni shipped. An earlier wording made agents over-trust the
search and answer worse; the shipped wording, which says the evidence rating cannot see what the search
missed, fixed that. Keep that meaning if you adapt the text. The same caution is repeated in the first
lines of every evidence pack.

Keywords matter. The evaluation used keywords chosen by the agent, which knows the question's
vocabulary. Keywords derived from the question work for quick human use but usually find less, so the
skill and the MCP tool ask the agent for keywords.

### Agent skill

[`skills/genigrep/SKILL.md`](skills/genigrep/SKILL.md) is an [Agent Skill](https://agentskills.io): when
to use genigrep (questions that span unfamiliar code), when not to (a known symbol, file or string), how
to call it, and how to use the results (read the passages first, do not re-read them, check what they
do not cover, verify critical claims). Install it by copying the directory from a clone of this
repository:

| Agent | All projects | One project |
| --- | --- | --- |
| Claude Code | `cp -r skills/genigrep ~/.claude/skills/` | `cp -r skills/genigrep <project>/.claude/skills/` |
| Codex | `cp -r skills/genigrep ~/.agents/skills/` | `cp -r skills/genigrep <project>/.agents/skills/` |
| Other agents | Copy `skills/genigrep` into the agent's skills directory. | |

Once this repository is public, `npx skills add Cloudgeni-ai/genigrep` installs the skill for the
agents it detects.

The skill runs the `genigrep` command, so install it and store a key first ([Quick start](#quick-start)).

### MCP server

`genigrep mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server on stdin and
stdout with one tool, `code_search`. Its inputs are OpenGeni's tool schema plus a directory:

| Input | Meaning |
| --- | --- |
| `question` (required) | One precise question about the code. |
| `keywords` (required) | 6-15 likely identifiers, file-name fragments, config keys, error strings and synonyms. |
| `subQuestions` | Up to 3 distinct parts of the question. |
| `paths` | Up to 8 files or directories to limit the search to, relative to the searched directory. |
| `directory` | The directory to search, absolute or relative to the project root. Default: the project root. |

The result is the evidence pack as text, ending with the directory its paths are relative to. Failures
(no key, Jev down, invalid arguments) come back as tool errors that tell the agent to search with `rg`
instead. The server also sends OpenGeni's code search instruction as MCP server instructions, which
clients that support them add to the agent's context.

Which directories the server searches:

1. The directories given on its command line (`genigrep mcp ~/src/app ~/src/lib`), if any.
2. Otherwise the workspace roots the client reports.
3. Otherwise the directory the client started it in. If that is the home directory or the filesystem
   root, a call must name its `directory`; genigrep does not guess.

A call's `directory` must stay inside those directories, and a credentials directory such as `~/.aws`
is never searched.

The server reads the key stored by `genigrep auth` on every call, so no key goes into the client's
configuration, and running `genigrep auth` later takes effect without a restart. If you use
`GENIGREP_JEV_API_KEY` instead, make sure the client passes it to the server.

The examples below run `genigrep` from your PATH (see [Install](#install)). Once genigrep is on npm,
`npx -y genigrep mcp` works without a global install.

**Claude Code**

```bash
claude mcp add --scope user genigrep -- genigrep mcp
```

Or, for one project, in `.mcp.json` at the project root:

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
# Only when the key comes from the environment instead of `genigrep auth`:
# env_vars = ["GENIGREP_JEV_API_KEY"]
```

**Cursor**

In `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "genigrep": { "command": "genigrep", "args": ["mcp"] }
  }
}
```

Cursor reports the open workspace as MCP roots, and genigrep searches them. In a project's
`.cursor/mcp.json` you can name the folder instead: `"args": ["mcp", "${workspaceFolder}"]`.

Other MCP clients: run `genigrep mcp` as a stdio server. `genigrep help mcp` lists its options.

### Instructions snippet

For agents without skills or MCP, add something like this to your agent instructions:

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

This is the tool description OpenGeni ships, adapted to the command line. Keep its last two sentences.

## How it works

The engine is a five-stage pipeline (a port of the research prototype scout-0.3.1; ranking, thresholds
and defaults unchanged):

1. **Recall.** One ripgrep pass over every keyword's identifier variants (case-insensitive; camelCase,
   snake_case, kebab-case and spaced forms), then IDF scoring per file. Up to 240 candidate files.
2. **File triage.** Jev judges each candidate by its path and up to three matching lines. A lexical
   guard always keeps the top lexical files, so a judge miss cannot drop them.
3. **Passage verification.** The selected files are cut into line-numbered windows around their hits,
   aligned to enclosing declarations. Jev scores each passage's relevance and its coverage of each
   sub-question.
4. **Leads.** Identifiers referenced by the best passages are scored once, and the definitions of the
   chosen ones are located with ripgrep and verified the same way (exactly one round).
5. **Pack.** Passages above the relevance threshold are packed within the token budget, grouped by
   file, trimmed to whole lines when needed, and one final Jev check rates whether they answer the
   question.

What genigrep never reads: files excluded by `.gitignore` (also outside a git repository), `.ignore`
and `.rgignore`; binary files; dependency, build and cache directories (`node_modules`, `dist`,
`build`, `target`, `vendor`, `.venv`, `__pycache__` and more); lock files, minified and generated files;
and common secret files (`.env` and its local and per-environment variants, private keys, `*.tfvars`,
`*.tfstate`, `.npmrc`, `.netrc`, credential JSON files, `.ssh/`, `.aws/` and others). Example env files
such as `.env.example` stay searchable. The full lists are in `src/workspace/excludes.ts` and
`src/engine/code-search/recall.ts`.

## What is sent to Jev

genigrep does not upload your repository. Jev receives only the text it needs to judge:

- the question and sub-questions;
- for file triage, the paths of up to 240 candidate files, each with up to 3 matching lines (160
  characters each);
- for verification, up to 80 passages, plus up to 6 definitions followed from leads, of up to 8,000
  characters each (4,000 for prose), with their paths, line numbers and enclosing declaration (a small
  file can fit in one passage);
- for leads, up to 60 identifier names with the path, line and text where they were seen;
- for the final check, up to 60,000 characters of the packed passages.

Keywords, file listings beyond the candidates and anything the ignore rules exclude are never sent.
genigrep does not scan contents for secrets: a credential hard-coded in an ordinary source file can be
sent as part of a passage. See [SECURITY.md](SECURITY.md).

Requests go to `https://api.typesafe.ai` (`GENIGREP_JEV_BASE_URL` changes it; HTTPS is required except
for `localhost`). The key travels only in the `Authorization` header.

## Cost and speed

Jev costs $0.042 per million input tokens (output is free). In the evaluation below a search cost about
$0.006 on average. Jev requests run in parallel, so the wall time is a few round trips.

Examples on the OpenGeni repository (about 6,300 files), run from a laptop. Each made 13-21 Jev
requests totalling 72k-121k input tokens and took 2.1-2.4 seconds:

| Question | Keywords | Passages | Time | Jev requests | Cost |
| --- | --- | --- | --- | --- | --- |
| Where is the Codex usage limit error classified? | derived from the question | 12 from 9 files | 2.4 s | 19 | $0.0051 |
| Where is the Codex usage limit error classified? | 8 given with `-k` | 15 from 10 files | 2.3 s | 17 | $0.0038 |
| How does the Jev client decide which HTTP failures to retry, and how long does it wait between attempts? (plus one `-s`) | 8 given | 13 from 7 files | 2.1 s | 13 | $0.0030 |
| Which conditions decide whether a turn is offered the code_search tool? | 7 given | 16 from 12 files | 2.3 s | 21 | $0.0041 |

## Evidence

genigrep's engine was evaluated as OpenGeni's `code_search` tool, inside the OpenGeni agent harness,
not as this command line tool. The setup: 26 real questions about the OpenGeni codebase, answered by an
agent with and without the tool, graded by two blind graders, compared with paired statistics.
Brackets are the paired intervals the study reported.

| Run | Cost | Time | Other |
| --- | --- | --- | --- |
| Run 1, `gpt-6-astra` | -6.6% [-11.5, -1.9] | -9.1% [-13.4, -4.6] | |
| Run 2, `gpt-6-sol` (xhigh reasoning) | -7.5% [-14.2, +0.4] | -9.8% [-17.9, +0.6] | model calls 19.4 to 16.2 per question; pass rate +1.9 points [-4.8, +8.7] |

In short: about 7% lower cost and about 10% less time at equal answer quality. Run 2's intervals include
zero, so read its savings as consistent with run 1 rather than as an independent confirmation.

Two more results shaped the design:

- A keyword-only variant, the same pipeline without Jev, lost 7.7 points of answer quality. That is why
  genigrep fails instead of silently degrading when Jev is down.
- On bug-fixing benchmarks (Terminal-Bench 2.1 and SWE-rebench, 12 tasks, 1 trial each) there was no
  measurable effect either way. That sample is small.

Limits of this evidence: one codebase (TypeScript, about 6,300 files), 26 questions, one agent
harness, and agents that also had ordinary shell search available. Keywords derived by genigrep itself,
the agent skill and the MCP server were not evaluated. Other repositories, languages and agents may
differ.

### TODO: head-to-head against jevgrep

> **TODO.** A head-to-head comparison against jevgrep is running separately. Results will be added
> here when they are available. No numbers have been measured for this section yet.

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| API key | `GENIGREP_JEV_API_KEY`, else the config file (`genigrep auth`) | none |
| Jev endpoint | `GENIGREP_JEV_BASE_URL` or `jevBaseUrl` in the config file | `https://api.typesafe.ai` |
| Jev model | `GENIGREP_JEV_MODEL` or `jevModel` in the config file | `jev-latest` |
| Jev request timeout | `GENIGREP_JEV_TIMEOUT_MS` (1000-120000) | `10000` |
| ripgrep binary | `GENIGREP_RG_PATH` | bundled `@vscode/ripgrep`, then `rg` on PATH |

The config file is `$XDG_CONFIG_HOME/genigrep/config.json` (default `~/.config/genigrep/config.json`;
`%APPDATA%\genigrep\config.json` on Windows), created with mode `600` in a `700` directory. genigrep
warns when the file is readable by other users. The key is never printed: `genigrep auth --status` and
`genigrep doctor` say where it comes from, not what it is.

To exclude more paths, list them in a `.ignore` or `.rgignore` file (gitignore syntax) in the searched
directory.

## Library

```ts
import { genigrep } from "genigrep";

const result = await genigrep({
  question: "How is the retry delay computed?",
  keywords: ["retryDelay", "backoff", "RETRY_MAX"],
  root: "/path/to/repo",
  apiKey: process.env.GENIGREP_JEV_API_KEY!,
});
console.log(result.text); // the rendered pack
for (const p of result.passages) console.log(p.path, p.start, p.end, p.rel);
```

For hosts that wire code search into their own agent tools, the package also exports the engine
(`runCodeSearch`, `JevClient`, `JevCircuitBreaker`), the tool surface (`CODE_SEARCH_TOOL_DESCRIPTION`,
`CODE_SEARCH_DIRECTIVE`, `codeSearchInputSchema`, `parseCodeSearchArguments`, `renderCodeSearchError`), the `LocalWorkspace`
adapter and the `CodeSearchWorkspace` interface for other workspaces (OpenGeni implements it over its
sandboxes).

## Development

```bash
bun install
bun run typecheck
bun run build
bun test          # never calls the real Jev API; the dist and MCP stdio tests run dist/cli.js under Node
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before changing the engine's ranking or wording.

## Origin and license

genigrep is licensed under the [Apache License 2.0](LICENSE). The engine in `src/engine` was ported
from OpenGeni's `packages/jev` (Apache-2.0); see [NOTICE](NOTICE) for attribution and the exact source
commit. ripgrep is by Andrew Gallant and contributors (MIT or Unlicense); `@vscode/ripgrep` is by
Microsoft (MIT).
