/**
 * One search over a local directory: validate the input like the agent tool does, derive keywords when
 * none are given, and run the engine over a LocalWorkspace with a Jev client.
 */
import { resolve } from "node:path";
import {
  CODE_SEARCH_LIMITS,
  CodeSearchArgumentError,
  JevClient,
  parseCodeSearchArguments,
  runCodeSearch,
  type CodeSearchConfig,
  type CodeSearchResult,
} from "./engine";
import { deriveKeywords } from "./keywords";
import { LocalWorkspace, type LocalWorkspaceOptions } from "./workspace/local";

export const MIN_BUDGET_TOKENS = 1_000;
export const MAX_BUDGET_TOKENS = 100_000;

export interface GenigrepOptions {
  /** One precise question about the code. */
  question: string;
  /** Likely identifiers, file-name fragments, config keys, error strings and synonyms (6-15 work best). Derived from the question when empty. */
  keywords?: string[] | undefined;
  /** Distinct parts of a multi-part question (up to 3). */
  subQuestions?: string[] | undefined;
  /** Files or directories inside `root` to limit the search to (up to 8). */
  paths?: string[] | undefined;
  /** Directory to search. Default: the current directory. */
  root?: string | undefined;
  /** TypeSafe Jev API key. */
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  /** Jev per-request timeout. */
  timeoutMs?: number | undefined;
  /** Max evidence pack size in tokens (default 12,000). */
  budgetTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Name that starts the status header line (default "genigrep"). */
  headerName?: string | undefined;
  workspace?: LocalWorkspaceOptions | undefined;
  /** Tuning and tests only. */
  config?: CodeSearchConfig | undefined;
  /** Tests only: replaces global fetch for Jev requests. */
  fetch?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  onStage?: ((stage: string, data: Record<string, unknown>) => void) | undefined;
}

export interface GenigrepResult extends CodeSearchResult {
  /** Real path of the searched directory. */
  root: string;
  question: string;
  keywords: string[];
  /** The keywords were derived from the question. */
  keywordsDerived: boolean;
  subQuestions: string[];
  paths: string[];
}

export async function genigrep(options: GenigrepOptions): Promise<GenigrepResult> {
  let keywords = (options.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  const keywordsDerived = keywords.length === 0;
  if (keywordsDerived) {
    keywords = deriveKeywords(options.question);
    if (!keywords.length) {
      throw new CodeSearchArgumentError(
        "could not derive keywords from the question; pass likely identifiers with --keyword",
      );
    }
  }
  const args = parseCodeSearchArguments({
    question: options.question,
    keywords,
    subQuestions: options.subQuestions ?? [],
    paths: options.paths ?? [],
  });
  const budget = options.budgetTokens;
  if (
    budget !== undefined &&
    !(Number.isInteger(budget) && budget >= MIN_BUDGET_TOKENS && budget <= MAX_BUDGET_TOKENS)
  ) {
    throw new CodeSearchArgumentError(
      `budget must be an integer from ${MIN_BUDGET_TOKENS} to ${MAX_BUDGET_TOKENS} tokens`,
    );
  }
  const workspace = new LocalWorkspace(resolve(options.root ?? "."), options.workspace ?? {});
  const jev = new JevClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    timeoutMs: options.timeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const result = await runCodeSearch({
    question: args.question,
    keywords: args.keywords,
    subQuestions: args.subQuestions,
    paths: args.paths,
    workspace,
    jev,
    signal: options.signal,
    budgetTokens: budget,
    config: options.config,
    onStage: options.onStage,
    headerName: options.headerName ?? "genigrep",
  });
  return {
    ...result,
    root: workspace.root,
    question: args.question,
    keywords: args.keywords,
    keywordsDerived,
    subQuestions: args.subQuestions,
    paths: args.paths,
  };
}

export { CODE_SEARCH_LIMITS as GENIGREP_LIMITS };
