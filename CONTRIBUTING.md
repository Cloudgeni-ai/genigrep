# Contributing

## Development

Requirements: [Bun](https://bun.sh) 1.3 or newer for development, Node.js 20 or newer to run the built CLI.

```bash
bun install
bun run typecheck
bun test            # unit, adapter and CLI tests; never calls the real Jev API
bun run build       # dist/index.js, dist/cli.js, dist/index.d.ts
node dist/cli.js --help
```

`bun run check` runs the typecheck, the build and the tests, in that order. `test/dist.test.ts` and
`test/mcp-stdio.test.ts` run the built CLI under Node against a local fake Jev server, so run
`bun run build` before `bun test` to include them. The MCP tests use the official MCP SDK client, a
development dependency only; the server itself (`src/mcp/protocol.ts`) has no runtime dependency.

To try a real search, store a key once (`node dist/cli.js auth`) or set `GENIGREP_JEV_API_KEY` for the
command, then run `node dist/cli.js doctor`.

## The engine

`src/engine` is a port of OpenGeni's `packages/jev` (see NOTICE). Its ranking, thresholds and defaults
(`DEFAULT_CODE_SEARCH_CONFIG`) and its Jev prompts were tuned against an evaluation set; change them only
together with a new evaluation, and say so in the pull request. Changes that keep behavior (adapters,
output, the CLI) are welcome as usual.

The model-facing wording matters as much as the ranking. The tool description and the pack header tell
the agent that the evidence rating cannot see what the search missed. An earlier wording made agents
over-trust the search and answer worse, so keep that meaning in any text an agent reads: the CLI help,
the MCP tool description and instructions (`src/mcp/server.ts`) and the agent skill
(`skills/genigrep/SKILL.md`).

## Documentation

- [README.md](README.md) is the entry point: install, agent setup, measured results, privacy,
  configuration and limitations. Keep it short and link to details.
- [docs/how-it-works.md](docs/how-it-works.md) describes the pipeline and its limits with the default
  numbers. Update it in the same pull request when you change a default, a limit, the ignore lists, what
  is sent to Jev, or the output format.
- Results in the README must come from a real evaluation with its sample size and intervals. Do not add
  numbers without them.
- Write plain, concise English and use plain hyphens rather than em dashes.

## Reporting problems

Use the issue templates: "Bug report" for crashes and wrong behavior, "Search quality" when genigrep
misses or misranks the code that answers a question (a public repository makes it reproducible). Report
security issues privately as described in [SECURITY.md](SECURITY.md).

## Pull requests

- Keep commits focused and describe the user-visible effect.
- Add or update tests for behavior changes; `bun test` must pass without network access.
- Never commit API keys, `.env` files or output that contains them.

## Releasing

Publishing is disabled while the repository is private. Once it is public:

1. Configure npm publishing: either an `NPM_TOKEN` secret in a GitHub environment named `npm`, or an npm
   trusted publisher for this repository and the `release.yml` workflow.
2. Set the repository variable `GENIGREP_RELEASE_ENABLED` to `true`.
3. Bump `version` in `package.json`, update `CHANGELOG.md`, merge, and push a tag `vX.Y.Z`.
4. Run the Release workflow by hand with that tag (or add the `push: tags` trigger shown in
   `.github/workflows/release.yml`).
