# How genigrep works

genigrep answers one question about a codebase with the passages that answer it. The work is split
three ways:

- **Code** does everything deterministic: ripgrep, scoring by keyword rarity, cutting files into
  passages, following definitions, packing the result into a budget.
- **Jev**, TypeSafe's judge model, answers narrow yes/no questions ("would reading this file help
  answer the question?") with a probability. It never writes text.
- **The agent** (or you) reads the passages and does the reasoning.

This page describes the engine in `src/engine`, the local filesystem adapter in `src/workspace`, the
output and the MCP server. The engine is scout-0.4, the version OpenGeni's `code_search` runs. The
numbers below are the defaults in
[`src/engine/code-search/config.ts`](../src/engine/code-search/config.ts). They were tuned on
evaluation sets and are the same as in OpenGeni.

## Contents

- [Jev](#jev)
- [The pipeline](#the-pipeline)
- [Output](#output)
- [Failures](#failures)
- [What is sent to Jev](#what-is-sent-to-jev)
- [The local workspace](#the-local-workspace)
- [MCP server](#mcp-server)
- [Why the wording matters](#why-the-wording-matters)
- [Differences from OpenGeni's code_search](#differences-from-opengenis-code_search)

## Jev

A Jev request carries a shared state (for example a list of candidate files) and many short questions
about it, and returns one probability per question. OpenGeni measured about 0.4 seconds per request.
Jev is an API from [TypeSafe](https://typesafe.ai).

The client in [`src/engine/client.ts`](../src/engine/client.ts):

- splits a large set of questions into several requests so each stays within Jev's limits (32k
  tokens for the state plus the longest question, 64k for the state plus all questions);
- runs up to 16 requests at once, and opens keep-alive connections while ripgrep runs so the first
  requests do not wait for TLS;
- retries network errors, timeouts, HTTP 429 and 5xx up to two times, with a short backoff that
  honours `retry-after` up to 2 seconds. Other 4xx responses are not retried;
- treats 401, 402 and 403 as a key or billing problem;
- sends the key only in the `Authorization` header and never puts it in an error message.

The default per-request timeout is 10 seconds (`GENIGREP_JEV_TIMEOUT_MS`).

## The pipeline

### 1. Recall

Each keyword is expanded into its identifier variants: camelCase, snake_case, kebab-case and a spaced
phrase for prose. The search is case-insensitive, so PascalCase and SCREAMING_CASE are covered too.
Short plain words (up to 5 characters) get a leading word boundary, so `turn` does not match
`return`.

One ripgrep pass searches all variants at once (a very long pattern is split into a few calls). It
includes hidden files (`.github/`, `.env.example`)
but never `.git/`, skips files over 4 MB and ignores lines longer than 8,000 characters (minified or
generated content). It keeps up to 25 matching lines per file per keyword. A separate file listing
matches keywords against file paths.

Each file is scored by the rarity (IDF) of the distinct keywords it matches, plus a bonus when the
path matches a keyword and a small tie-breaker for the number of matching lines. Test files and
release notes (`CHANGELOG*`, `.changeset/`) count less unless the question is about tests or history.
A compound keyword with no hits (`shouldCompactContext`) is retried as its two-word fragments
(`compactContext`), and the output lists keywords that matched nothing.

The top 240 files become candidates. With `--in`, only those paths are searched; if fewer than 5
candidates are found there, the whole directory is searched and the output says so.

### 2. File triage (Jev wave 1)

Jev sees each candidate as its path plus its three best matching lines, cut to 160 characters, 60
files per request, and answers whether reading the file would help answer the question. The rubric
counts files that implement, decide, compute, configure, enforce or document the asked behavior, and
excludes files that only mention the same words.

Files with a probability of at least 0.6 are selected, up to 16. The 8 best-ranked files are always
selected, and the 5 best files by keyword score are always kept, so one judge miss cannot drop an
obvious candidate.

### 3. Symbols

The selected files declare, import, call and render identifiers that no keyword named: the hook behind
the data, the other handler that mutates the same state. genigrep collects them, ranks them cheaply
(how many relevant files use them, whether they occur near a keyword hit or share words with the
question, and whether they are imported or called) and has Jev judge the best 160, each shown with one
place it occurs. For up to 10 identifiers with a probability of at least 0.5,
one ripgrep pass finds their definitions and usages across the workspace. An identifier found in more
than 40 files counts as generic: its definition is still followed, its usages are not.

The files these identifiers lead to join the evidence: up to 6 new files, ranked by their symbol hits
(files of at most 300 lines are tiled whole, see below), plus up to 3 new windows per file already
selected. Symbol discovery runs alongside the passage check, and its windows are verified in the same
Jev round as the leads, so it adds no round of its own.

### 4. Passage check (Jev wave 2)

The most relevant small files (up to 6 files of at most 900 lines, selected with a probability of at
least 0.6) are cut into declaration-sized tiles of about 20 lines, at most 24 per file, so every
function and handler in them is judged.

Other selected files are cut into passages around their matches. From each match genigrep walks up
(at most 40 lines) to the enclosing declaration and down (at most 120 lines) to where that block
closes. It recognises declarations in TypeScript and JavaScript, Rust, Go, Python and YAML, headings
in Markdown and statements in SQL. When it finds no enclosing declaration, it takes 10 lines above and
30 below the match and labels the passage with the nearest declaration further up.

Passages that overlap or nearly touch are merged, passages over 150 lines are split around clusters of
matches, and each file keeps its best 5 (12 for a relevant file too large to tile). At most 200
passages are checked, taken round-robin across files. Lines over 400 characters (1,600 in prose files)
are cut with a marker.

Jev scores every passage for relevance and, for each sub-question, for whether the passage shows that
part of the answer. Passages are sent 4 per request.

In the same round, Jev answers a "must change together" question for up to 60 functions of the three
most relevant code files (at most 25 per file), each shown by its signature and the calls it makes:
would a correct answer or change also have to read or change it? Up to 6 functions with a probability
of at least 0.5 are kept and packed right after each sub-question's best passage. This catches
sibling code that a literal relevance check scores low, such as another handler that mutates the same
state.

### 5. Leads (Jev wave 3)

From the 12 most relevant passages (relevance at least 0.5, or at least 0.3 when fewer pass),
genigrep collects identifiers the passages use but do not define: called functions, imported names,
types, constants and config keys. It leaves out the keywords already searched, language built-ins,
common helpers and names shorter than 4 characters. One ripgrep call locates their definitions,
preferring the file where the name was seen and then its package. Names with no definition, or whose
definition is already in the evidence, are dropped, and names defined in many files count less.

Jev scores up to 60 leads. The definitions of up to 6 leads with a probability of at least 0.5 are
cut into passages, together with up to 3 call sites of each (outside the evidence, non-test files
first; none for a name used in more than 40 files), and checked like wave 2 in one round with the symbol windows. genigrep does not follow leads
of leads.

### 6. Pack and evidence rating

Passages are packed in this order: for each sub-question, the best passage that covers it (a weak
sub-question still gets its best 2 passages with coverage of at least 0.3); then every passage with
relevance of at least 0.5, best first; and if fewer than 4 passed, the next best above 0.1.
Documentation and release notes are ranked lower, and so is a passage that is mostly import lines. A
second passage from the same file has to beat the best passage of another file by a margin, so the
output covers more files.

The budget is 12,000 tokens by default (`-b`), estimated at 3.2 characters per token; 22% of it is
reserved for the footer. A relevant file whose whole rendering fits in 5,000 characters is shown
whole. A passage over 3,200 characters, or one that does not fit, is trimmed to whole lines around
its matches (at least 15 lines) and marked as trimmed. Passages are never cut mid-line. Two passages
of one file at most 12 lines apart are joined, because the gap is usually the glue the reader needs.

Finally one Jev request asks whether the packed passages, up to 60,000 characters of them, show the
answer to the question and to each sub-question. That probability is the **evidence rating** in the
first line of the output. When it is low, the pack adapts once:

- below 0.4, genigrep follows the next leads and call sites, repacks and rates again;
- below 0.7, it fills the rest of the budget with the next-best passages (relevance at least 0.3);
  the header then says the rating covers the passages above the bar.

### 7. What the pack did not show

The pack ends with a footer that tells the reader where to look next:

- the relevant files (up to 16), each with the line ranges shown and not shown, the functions declared
  in the not-shown ranges (up to 16 per file), and verified passages that scored below the bar. Before
  changing code in one of them, read the not-shown ranges in full;
- every limit that cut something (files, windows, passages, identifiers, leads, call sites and the
  token budget), with the cut files and line ranges;
- other candidates, leads not followed, keywords that matched nothing and keywords that matched only
  files judged irrelevant, each with similar identifiers that exist in the workspace.

When the footer does not fit its share, the weakest list entries go first; the coverage of the top
files stays.

In OpenGeni, on 138 real searches replayed at their own commits, scout-0.4 compared with
scout-0.3.1:

- the share of the regions agents later edited or cited that the pack contains rose from 13% to 18%;
- the share it contains or points to by line range rose from 29% to 57%;
- packs grew from 8.8k to 10.6k tokens, and Jev cost per search rose by about 80%.

Most of the added lines are relevant: lines outside any region the agent later used rose 4%, while
lines inside them rose 49%.

## Output

The text output on stdout has three parts:

1. **Status line**: `genigrep: evidence rating 0.94 | 15 passages from 10 files, ~10.5k tokens |
   2.3s`, with one rating per sub-question when there are any. Then the sub-questions, and one line
   explaining how to read the passages and that the rating cannot see what the search missed.
2. **Passages**, grouped by file, best file first. Each starts with
   `== path:start-end  rel 0.96`, followed by the lines verbatim as `N| text` with their original
   line numbers. The header can also show `[s1]` (covers sub-question 1), `(whole file)`,
   `(definition of X)` for a followed lead, `(uses X)` for a call site of one,
   `[change together: X]`, `(trimmed from a-b)`, and `in L210: ...` naming the enclosing declaration
   when the passage starts inside one.
3. **Footer**: "Relevant files and what this pack did not show" (each file's shown and not-shown
   ranges, the functions declared in the not-shown ones and passages checked below the bar), "Cut by
   limits", "More candidates" (verified passages that did not fit and other candidate files with
   their triage score), "Leads not followed", keywords with zero hits or only irrelevant hits (with
   similar identifiers found in the workspace), and a note when the search widened beyond `--in`.

stderr gets one summary line with the number of Jev requests, input tokens and cost. `-v` adds the
keywords used, stage timings and counts; `-q` removes the summary line.

`--json` prints one object instead:

```text
{ genigrep, engine, root, question, keywords, keywordsDerived, subQuestions, paths,
  status, passages, leads, stats, text }
```

- `status` is `{ label, overall, subs }`, where `overall` and `subs` are the evidence ratings.
- Each passage is `{ path, start, end, rel, coverage, kind, lines }`, plus `definitionOf`, `uses`,
  `changeTogether`, `wholeFile`, `trimmedFrom` and `enclosing` when they apply. `kind` is `hit`,
  `header` or `def`.
- `leads` is the footer as data: `{ coverage, cuts, morePassages, moreFiles, leadsNotFollowed,
  zeroHitKeywords, irrelevantKeywords, note? }`. Each `coverage` entry is `{ path, lines, shown,
  notShown, checked, outline?, note? }` with ranges as `[start, end]` pairs; each keyword entry is
  `{ keyword, fragments, suggestions, files? }`. The lists are complete up to the engine's caps; the
  text footer may drop entries to fit its budget.
- `stats` has timings, counts and `jev: { requests, inputTokens, costUsd, model }`.
- `text` is the rendered text output.

On failure `--json` prints `{ "error": { "kind", "message" } }`. The exit codes are listed in the
[README](../README.md#usage).

## Failures

- **Jev fails** (unreachable, timed out, rate-limited after retries, key or billing rejected): the
  search fails with exit code 4. genigrep does not fall back to keyword-only ranking, because in the
  evaluation that lost 7.7 points of answer quality. Use `rg` instead.
- **Only the final rating request fails**: the passages are already Jev-scored, so genigrep returns
  them with `evidence rating unknown (check failed)`.
- **No passage passes**: exit code 1, with suggestions and the remaining candidates in the output.
- **ripgrep hits its time limit (30 seconds per call) or output cap**: the search continues with what
  it has, and the status line says the search was partial.
- **ripgrep is missing**: exit code 3.

## What is sent to Jev

Only the text Jev needs for judging:

| Stage | Sent |
| --- | --- |
| Every request | The question (inlined when it is at most 600 characters) and the sub-questions. |
| File triage | Paths of up to 240 candidate files, each with up to 3 matching lines of at most 160 characters. |
| Symbols | Up to 160 identifier names, each with the path, line and text of one place it occurs. |
| Passage check | Up to 200 passages (tiles of small relevant files and windows around matches), plus the windows of followed definitions, their call sites and symbol hits, each at most 8,000 characters (4,000 in prose files), with path, line numbers and the enclosing declaration. A small file can fit in one passage. |
| Change together | Up to 60 function names from the three most relevant code files, each with its path, line, signature and the calls it makes. |
| Leads | Up to 60 identifier names, each with the path, line and text of the line where it was seen. |
| Evidence rating | Up to 60,000 characters of the packed passages. |

Not sent: the keywords, file listings beyond the candidates, whole files beyond what fits in a
passage, and anything the ignore rules exclude. The key is sent only in the `Authorization` header.

## The local workspace

The engine never touches files directly. It goes through the `CodeSearchWorkspace` interface
([`src/engine/code-search/workspace.ts`](../src/engine/code-search/workspace.ts)), which OpenGeni
implements over its sandboxes and genigrep implements over a local directory in
[`src/workspace/local.ts`](../src/workspace/local.ts):

- **ripgrep**: `GENIGREP_RG_PATH`, else the binary from `@vscode/ripgrep`, else `rg` on PATH. It runs
  with `--no-config` (a user's ripgrep config file cannot change the search) and only a fixed list of
  flags. Flags that run programs (`--pre`), read other files or follow symlinks are rejected, and so
  are absolute paths and paths with `..`.
- **Ignore rules**: `.gitignore` (also outside a git repository), `.ignore` and `.rgignore`, plus
  built-in lists of dependency, build and cache directories, lock files, minified and generated files,
  images and archives, and OpenGeni's `.opengeni/` sandbox state (never searched, even when named).
  The lists are in
  [`src/workspace/excludes.ts`](../src/workspace/excludes.ts) and
  [`src/engine/code-search/recall.ts`](../src/engine/code-search/recall.ts).
- **Secret files** (`.env` and its variants, private keys, `*.tfvars`, `*.tfstate`, `.npmrc`,
  `.netrc`, credential JSON files, `.ssh/`, `.aws/`, `.gnupg/`, `.kube/` and others) are excluded
  twice, regardless of case: as ripgrep globs (`--iglob`), and by name, because ripgrep searches a
  file it is given explicitly even when a glob excludes it. A path given explicitly that is a link is
  checked by its target too. Example files such as `.env.example` stay searchable.
- **Credentials directories**: searching from inside `.ssh`, `.aws`, `.gnupg` or `.kube` is refused,
  because the exclude globs only match paths below the searched directory.
- **Bounds**: ripgrep output is capped at 32 MiB per call and cut at a line boundary; one file read
  is capped at 8 MiB; each ripgrep call is killed after its time limit or when the search is
  cancelled. Files whose first 8 KB contain a NUL byte are treated as binary and never shown.
- **Containment**: reads never leave the searched directory, including through symlinks.

## MCP server

`ggr mcp` ([`src/mcp/server.ts`](../src/mcp/server.ts)) runs a stdio MCP server with one
read-only tool, `code_search`:

| Input | Meaning |
| --- | --- |
| `question` (required) | One precise question about the code. |
| `keywords` (required) | 6-15 likely identifiers, file-name fragments, config keys, error strings and synonyms. |
| `subQuestions` | Up to 3 distinct parts of the question. |
| `paths` | Up to 8 files or directories to limit the search to, relative to the searched directory. |
| `directory` | The directory to search, absolute or relative to the project root. Default: the project root. |

`keywords` is required because the evaluation used keywords chosen by the agent. The result is the
text output, ending with the directory its paths are relative to. The server also sends OpenGeni's
code search instruction as MCP server instructions, which clients that support them add to the
agent's context.

**Which directories it searches:**

1. The directories given on its command line (`ggr mcp ~/src/app ~/src/lib`), if any.
2. Otherwise the workspace roots the client reports, read again when the client says they changed.
3. Otherwise the directory the client started it in. If that is the home directory or the filesystem
   root, a call must name a `directory` below it.

A call's `directory` must stay inside these directories.

**Key and settings.** The server reads the key and settings on every call, so running `ggr auth`
later takes effect without restarting the client. If you use `GENIGREP_JEV_API_KEY` instead, make
sure the client passes it to the server.

**Errors.** A missing key, Jev failures and invalid arguments come back as tool errors that tell the
agent to search with `rg`, `grep` or file reads instead. The server keeps one Jev circuit breaker:
after 3 consecutive Jev outages it refuses calls at once for 5 minutes (30 minutes after a 401, 402
or 403), then lets one trial call through. It logs to stderr only and never logs the key.

**Protocol.** The server implements the part of MCP it needs (initialize, ping, `tools/list`,
`tools/call`, cancellation and `roots/list`) over newline-delimited JSON-RPC in
[`src/mcp/protocol.ts`](../src/mcp/protocol.ts), without the MCP SDK at runtime. The tests drive it
with the official SDK client, in memory and over stdio.

## Why the wording matters

The text an agent reads about the tool changes how well it answers. An earlier OpenGeni version
labelled results `sufficient` or `partial` and told the agent to search further only for reported
gaps. It saved more, but lost answers to questions such as "does anything skip this validation?":
graders found the agent stopping at results that covered only one side. The current wording shows the
rating as a number and says plainly that it cannot see what the search missed, and that fixed it.

That sentence appears in the tool description, the MCP server instructions, the agent skill, the CLI
help and the header of every result. Keep its meaning if you change any of them.

## Differences from OpenGeni's code_search

The engine's ranking, thresholds, defaults, Jev prompts and text output are unchanged (scout-0.4, as
in OpenGeni), except that the status line starts with `genigrep`. genigrep adds:

- the local filesystem workspace adapter (OpenGeni runs ripgrep inside its sandboxes and transfers
  the output in compressed chunks);
- the command line tool, with `auth`, `doctor`, `--json` and exit codes;
- keywords derived from the question when none are given (not evaluated);
- the MCP server and the agent skill;
- structured `passages` and `leads` in the result (the footer as data), and a configurable name for
  the status line.
