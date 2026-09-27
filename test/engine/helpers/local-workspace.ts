/**
 * The engine tests' workspace: genigrep's LocalWorkspace plus a call log, and a stricter check that the
 * engine never passes a pattern longer than CODE_SEARCH_MAX_PATTERN_CHARS (the adapter itself accepts up
 * to 16,384 characters, like the OpenGeni sandbox adapter).
 */
import {
  CODE_SEARCH_MAX_PATTERN_CHARS,
  type CodeSearchRipgrepResult,
  type CodeSearchWorkspace,
} from "../../../src/engine";
import { LocalWorkspace, validateRipgrepArgs } from "../../../src/workspace/local";

/** Throws when args contain anything outside the documented ripgrep allowlist. */
export function assertAllowedRipgrepArgs(args: readonly string[]): void {
  validateRipgrepArgs(args);
  for (let i = 0; i < args.length && args[i] !== "--"; i++) {
    if (args[i] === "-e" && args[i + 1]!.length > CODE_SEARCH_MAX_PATTERN_CHARS) {
      throw new Error(
        `-e pattern of ${args[i + 1]!.length} chars (1..${CODE_SEARCH_MAX_PATTERN_CHARS} allowed)`,
      );
    }
  }
}

export interface LocalWorkspaceOptions {
  rgBin?: string;
  /** Cut ripgrep stdout at this many bytes (reports truncated). */
  maxStdoutBytes?: number;
}

export class LocalCodeSearchWorkspace implements CodeSearchWorkspace {
  readonly calls: Array<{ kind: "ripgrep" | "readText" | "pathKinds"; args: readonly string[] }> =
    [];
  private readonly inner: LocalWorkspace;

  constructor(
    readonly root: string,
    options: LocalWorkspaceOptions = {},
  ) {
    this.inner = new LocalWorkspace(root, {
      ...(options.rgBin ? { rgPath: options.rgBin } : {}),
      ...(options.maxStdoutBytes ? { maxStdoutBytes: options.maxStdoutBytes } : {}),
    });
  }

  async ripgrep(
    args: readonly string[],
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<CodeSearchRipgrepResult> {
    this.calls.push({ kind: "ripgrep", args });
    assertAllowedRipgrepArgs(args);
    return await this.inner.ripgrep(args, options);
  }

  async readText(path: string, options: { signal?: AbortSignal; maxBytes: number }) {
    this.calls.push({ kind: "readText", args: [path] });
    return await this.inner.readText(path, options);
  }

  async pathKinds(paths: readonly string[], options: { signal?: AbortSignal }) {
    this.calls.push({ kind: "pathKinds", args: paths });
    return await this.inner.pathKinds(paths, options);
  }
}
