# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/Cloudgeni-ai/genigrep/security/advisories/new)
rather than in a public issue. Include what you found, how to reproduce it and the genigrep version
(`genigrep --version`). We aim to acknowledge reports within a few working days.

## What genigrep protects

- **The API key.** It is read from `GENIGREP_JEV_API_KEY` or a config file created with mode `0600`
  (directory `0700`), sent only in the `Authorization` header to the Jev endpoint, and never printed or
  logged. `genigrep doctor` and `genigrep auth --status` say where the key comes from, not what it is.
  The endpoint must use HTTPS; plain HTTP is accepted only for `localhost`.
- **What leaves your machine.** Only the text Jev needs for judging is sent: the question and
  sub-questions, candidate file paths with up to three matching lines each, the passages being verified,
  identifiers found in them, and the final evidence. Whole files and file listings are not sent. See
  "What is sent to Jev" in the README.
- **What is never read.** Files excluded by `.gitignore`, `.ignore` and `.rgignore`, binary files,
  dependency and build directories, and common secret files (`.env`, `.env.local`, private keys,
  `*.tfvars`, `*.tfstate`, `.npmrc`, `.netrc`, credential JSON files, `.ssh/`, `.aws/` and others; see
  `src/workspace/excludes.ts`). A secret file is not searched even when named explicitly.
- **The searched directory.** ripgrep runs with `--no-config` and a fixed flag allowlist (no `--pre`, no
  symlink following), and reads never leave the searched directory, including through symlinks.
  A credentials directory (`.ssh`, `.aws`, `.gnupg`, `.kube`) is refused as the searched directory.
- **The MCP server.** `genigrep mcp` searches only the directories given on its command line, else the
  workspace roots the client reports, else the directory it was started in (never the home directory or
  the filesystem root by default). A tool call cannot search outside them. It logs to stderr only and
  never logs the key.

## What it does not protect

genigrep does not scan file contents for secrets. A credential hard-coded in an ordinary source file
can be sent to Jev as part of a passage, exactly as it would be pasted into any other AI tool. Keep
secrets out of source files, or add their paths to `.ignore` or `.rgignore`.
