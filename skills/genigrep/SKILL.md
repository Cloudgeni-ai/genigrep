---
name: genigrep
description: Find where something is implemented, configured or decided in a codebase with one genigrep call, which returns only the verified source passages that answer a question. Use it when a question spans code you do not know yet, such as where X is decided, how Y flows from request to result, what configures Z, or whether a check can be skipped. Do not use it when you already know the symbol, file or exact string; use rg or read the file directly.
license: Apache-2.0
compatibility: Needs the genigrep command (Node.js 20 or newer) with a TypeSafe Jev API key stored by `genigrep auth`, or the code_search tool from `genigrep mcp`.
---

# genigrep

genigrep answers a question about a codebase with the source that answers it. It runs one wide ripgrep
pass for your keywords, has a fast relevance model rank the files and verify line-numbered passages,
follows definitions one level, and returns the best passages verbatim with paths and line numbers. One
call replaces a series of separate searches and file reads.

If a `code_search` tool from the genigrep MCP server is available, call it with the same inputs
(`question`, `keywords`, `subQuestions`, `paths`, `directory`) instead of running the command.

## When to use it

Start with one genigrep call, instead of a series of separate searches and file reads, when you need
to find where something is implemented, configured or decided in code you do not know yet:

- "Where is the retry limit decided?", "What configures the upload size?"
- "How does a request get from the API route to the database write?"
- "Is authentication required for this endpoint, and what could skip it?"

## When not to use it

- You already know the symbol, file or exact string: run `rg -n 'name'` or read the file directly.
- You need every occurrence (a rename, counting call sites): rg is exhaustive; genigrep returns only
  the best passages.
- The answer is in files genigrep never reads: gitignored files, dependency and build directories,
  binaries and secret files such as `.env`.

## How to call it

```bash
genigrep "<one precise question>" -k <keyword>,<keyword>,... [-s "<part of the question>"] [--in <dir>] [dir]
```

- Give 6-15 keywords: likely identifiers (camelCase, snake_case, UPPER_CASE), file-name fragments,
  config or env keys, error strings and synonyms. Case and camel/snake/kebab variants are searched
  automatically. Good keywords matter most; keywords genigrep derives from the question find less.
- When the question asks whether something is required, enforced or the default, add a sub-question
  (`-s`) and keywords for what could skip, bypass or override it. Up to 3 sub-questions.
- `--in <path>` limits the search to a file or directory you already know is relevant (repeatable).
- The positional `dir` picks the directory to search (default: the current directory). Output paths
  are relative to it.

Example:

```bash
genigrep "Where is the usage limit error classified, and what happens after it?" \
  -k usageLimit,usage_limit_reached,rate_limit,429,classifyError,quota,retryAfter \
  -s "What does the caller do after the error is classified?"
```

## How to use the results

stdout is an evidence pack: a status line with an evidence rating, then the passages verbatim as
`N| text` lines with their original line numbers, grouped by file, best first, then leads the search
did not follow. A one-line cost summary goes to stderr.

- Read the returned passages first and use them directly. Do not re-read the same line ranges with
  `cat`, `sed -n` or a file read; you already have them.
- Do not over-trust the result. The evidence rating covers only what the search returned; it cannot
  see what the search missed. Spend follow-up searches outside those passages: other entry points to
  the same outcome (API routes, automatic or self-service paths), defaults, flags, exceptions and the
  unfollowed leads.
- Follow leads only as needed. "More candidates" lists verified passages that did not fit, "Leads not
  followed" lists identifiers whose definitions were not read, and zero-hit keywords point at wrong
  vocabulary.
- Verify critical claims before relying on them: read the surrounding code or run a targeted `rg`
  before you state a conclusion as fact or change code based on it.
- Cite answers as `path:line` from the passages.

## When it fails

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | Passages found | Use them as above. |
| 1 | No passage was verified | Try once more with different keywords or a narrower question, then use rg. |
| 2 | Invalid arguments | Fix the command line (quote the question). |
| 3 | Setup problem (no API key, no ripgrep, missing directory) | Use rg, and tell the user to run `genigrep auth` or `genigrep doctor`. |
| 4 | The relevance model failed or rejected the key | Use rg; do not retry in a loop. |
| 5 | Other failure | Use rg. |

Never ask for, print or pass the API key on the command line; genigrep reads it from its own config
or the `GENIGREP_JEV_API_KEY` environment variable.
