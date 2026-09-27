/**
 * LocalWorkspace: the code search workspace over a local directory. ripgrep runs as a child process in
 * the root (bundled binary or system rg), files are read with node:fs under size bounds, and nothing
 * outside the root, no secret file and no path the ignore rules exclude is ever returned.
 */
import { spawn } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  CodeSearchRipgrepMissingError,
  CodeSearchWorkspaceError,
  type CodeSearchRipgrepResult,
  type CodeSearchWorkspace,
} from "../engine";
import { findRipgrep } from "../ripgrep";
import { DEPENDENCY_EXCLUDE_GLOBS, SECRET_EXCLUDE_GLOBS, isSecretDirectory, isSecretPath } from "./excludes";

/** ripgrep stdout kept per call; more is cut at a line boundary and reported as truncated. */
export const LOCAL_RIPGREP_MAX_STDOUT_BYTES = 32 * 1024 * 1024;
/** Upper bound on one file read, whatever the engine asks for. */
export const LOCAL_MAX_READ_BYTES = 8 * 1024 * 1024;
/** Longest -e pattern accepted (the engine splits its patterns at 16,000 characters). */
export const LOCAL_MAX_PATTERN_CHARS = 16_384;
const BINARY_SNIFF_BYTES = 8192;

const BARE_FLAGS: ReadonlySet<string> = new Set([
  "--files",
  "--null",
  "--line-number",
  "--with-filename",
  "--no-heading",
  "-i",
  "-w",
  "--no-require-git",
  "--hidden",
]);
const VALUE_FLAGS: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ["--color", (v: string) => v === "never"],
  ["-m", (v: string) => /^[1-9]\d{0,5}$/.test(v)],
  ["--max-columns", (v: string) => /^[1-9]\d{0,6}$/.test(v)],
  ["--max-filesize", (v: string) => /^[1-9]\d{0,9}$/.test(v)],
  ["-g", (v: string) => v.length > 0 && v.length <= 512],
  ["-e", (v: string) => v.length > 0 && v.length <= LOCAL_MAX_PATTERN_CHARS],
]);

/**
 * Split engine ripgrep arguments into flags and paths, accepting only the documented allowlist. Flags that
 * run programs (`--pre`), read other files (`-f`, `--ignore-file`) or follow symlinks are rejected, and so
 * are paths that are absolute, start with "-" or contain "..".
 */
export function validateRipgrepArgs(args: readonly string[]): {
  flags: string[];
  paths: string[];
} {
  const flags: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.includes("\0")) throw new CodeSearchWorkspaceError("ripgrep argument contains NUL");
    if (arg === "--") break;
    if (BARE_FLAGS.has(arg)) {
      flags.push(arg);
      continue;
    }
    const valid = VALUE_FLAGS.get(arg);
    const value = args[i + 1];
    if (!valid || value === undefined || value.includes("\0") || !valid(value)) {
      throw new CodeSearchWorkspaceError(`ripgrep argument is not allowed: ${arg}`);
    }
    flags.push(arg, value);
    i++;
  }
  if (i >= args.length) throw new CodeSearchWorkspaceError("ripgrep arguments must end with -- and paths");
  const paths = args.slice(i + 1);
  if (!paths.length) throw new CodeSearchWorkspaceError("ripgrep needs at least one path");
  for (const p of paths) assertRelativePath(p);
  return { flags, paths };
}

function assertRelativePath(p: string): void {
  if (
    !p ||
    p.includes("\0") ||
    p.startsWith("-") ||
    isAbsolute(p) ||
    /^[A-Za-z]:/.test(p) ||
    p.split(/[\\/]/).includes("..")
  ) {
    throw new CodeSearchWorkspaceError(`path is not allowed: ${p}`);
  }
}

/** Cut `bytes` to at most `cap` bytes, ending after the last newline or NUL (whole records only). */
export function cutAtRecordBoundary(bytes: Uint8Array, cap: number): Uint8Array {
  const head = bytes.subarray(0, Math.min(cap, bytes.length));
  for (let i = head.length - 1; i >= 0; i--) {
    if (head[i] === 0x0a || head[i] === 0x00) return head.subarray(0, i + 1);
  }
  return head.subarray(0, 0);
}

export interface LocalWorkspaceOptions {
  /** ripgrep binary. Default: GENIGREP_RG_PATH, the bundled @vscode/ripgrep binary, then `rg` on PATH. */
  rgPath?: string | undefined;
  /** Cut ripgrep stdout at this many bytes (reported as truncated). */
  maxStdoutBytes?: number | undefined;
  /** Upper bound on one file read. */
  maxReadBytes?: number | undefined;
  /** ripgrep exclude globs added to every call, matched with case. Default: DEPENDENCY_EXCLUDE_GLOBS. */
  excludeGlobs?: readonly string[] | undefined;
  /** Secret-file exclude globs added to every call, matched without case (`--iglob`). Default: SECRET_EXCLUDE_GLOBS. */
  secretGlobs?: readonly string[] | undefined;
  /** Paths that are never searched or read, even when named explicitly or reached through a link. Default: isSecretPath. */
  isExcludedPath?: ((relPath: string) => boolean) | undefined;
}

export class LocalWorkspace implements CodeSearchWorkspace {
  /** Real path of the searched directory. */
  readonly root: string;
  private readonly rgPath: string | null;
  private readonly maxStdoutBytes: number;
  private readonly maxReadBytes: number;
  private readonly excludeGlobs: readonly string[];
  private readonly secretGlobs: readonly string[];
  private readonly isExcludedPath: (relPath: string) => boolean;

  constructor(root: string, options: LocalWorkspaceOptions = {}) {
    let real: string;
    try {
      real = realpathSync(resolve(root));
      if (!statSync(real).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new CodeSearchWorkspaceError(`not a directory: ${root}`);
    }
    if (isSecretDirectory(real)) {
      throw new CodeSearchWorkspaceError(`refusing to search a credentials directory: ${root}`);
    }
    this.root = real;
    this.rgPath = options.rgPath ?? findRipgrep()?.path ?? null;
    this.maxStdoutBytes = Math.max(1, options.maxStdoutBytes ?? LOCAL_RIPGREP_MAX_STDOUT_BYTES);
    this.maxReadBytes = Math.max(1, options.maxReadBytes ?? LOCAL_MAX_READ_BYTES);
    this.excludeGlobs = options.excludeGlobs ?? DEPENDENCY_EXCLUDE_GLOBS;
    this.secretGlobs = options.secretGlobs ?? SECRET_EXCLUDE_GLOBS;
    this.isExcludedPath = options.isExcludedPath ?? isSecretPath;
  }

  async ripgrep(
    args: readonly string[],
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<CodeSearchRipgrepResult> {
    options.signal?.throwIfAborted();
    const { flags, paths } = validateRipgrepArgs(args);
    const allowed: string[] = [];
    for (const p of paths) if (await this.searchable(p)) allowed.push(p);
    if (!allowed.length) return { stdout: "", exitCode: 1, truncated: false, timedOut: false };
    if (!this.rgPath) throw new CodeSearchRipgrepMissingError("ripgrep (rg) is not installed");
    const argv = [
      "--no-config",
      ...flags,
      ...this.excludeGlobs.flatMap((g) => ["-g", g]),
      // Added after every -g glob, so they take precedence.
      ...this.secretGlobs.flatMap((g) => ["--iglob", g]),
      ...(process.platform === "win32" ? ["--path-separator", "/"] : []),
      "--",
      ...allowed,
    ];
    return await runRipgrep(this.rgPath, argv, {
      cwd: this.root,
      timeoutMs: options.timeoutMs,
      maxStdoutBytes: this.maxStdoutBytes,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async readText(
    path: string,
    options: { signal?: AbortSignal; maxBytes: number },
  ): Promise<{ text: string; truncated: boolean; binary: boolean } | null> {
    options.signal?.throwIfAborted();
    const abs = this.inside(path);
    if (this.isExcludedPath(path)) return null;
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const real = await realpath(abs);
      // A link may point anywhere: the target must be inside the root and not a secret file either.
      if (!this.allowedTarget(real)) return null;
      fh = await open(abs, "r");
      const st = await fh.stat();
      if (!st.isFile()) return null;
      const n = Math.max(0, Math.min(st.size, options.maxBytes, this.maxReadBytes));
      const buf = Buffer.alloc(n);
      let read = 0;
      while (read < n) {
        const { bytesRead } = await fh.read(buf, read, n - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      const bytes = buf.subarray(0, read);
      return {
        text: bytes.toString("utf8"),
        truncated: st.size > read,
        binary: bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0),
      };
    } catch {
      // Per-file problems (missing, unreadable, a directory, a broken link) read as missing.
      return null;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  async pathKinds(
    paths: readonly string[],
    options: { signal?: AbortSignal },
  ): Promise<Record<string, "file" | "directory" | "missing">> {
    options.signal?.throwIfAborted();
    const out: Record<string, "file" | "directory" | "missing"> = {};
    for (const p of paths) {
      const abs = this.inside(p);
      if (p !== "." && this.isExcludedPath(p)) {
        out[p] = "missing";
        continue;
      }
      try {
        if (!this.allowedTarget(await realpath(abs))) {
          out[p] = "missing";
          continue;
        }
        const st = await stat(abs);
        out[p] = st.isDirectory() ? "directory" : st.isFile() ? "file" : "missing";
      } catch {
        out[p] = "missing";
      }
    }
    return out;
  }

  /**
   * Whether ripgrep may be given this path explicitly. ripgrep searches a named file even when a glob
   * excludes it, and follows a named link, so the name and the link's target must both pass.
   */
  private async searchable(path: string): Promise<boolean> {
    if (path === ".") return true;
    if (this.isExcludedPath(path)) return false;
    let real: string;
    try {
      real = await realpath(resolve(this.root, path));
    } catch {
      return true; // missing: ripgrep reports it like before
    }
    return this.allowedTarget(real);
  }

  /** A real path inside the root that is not, and is not inside, a secret file or directory. */
  private allowedTarget(real: string): boolean {
    if (!this.contains(real)) return false;
    const rel = relative(this.root, real);
    return rel === "" || !this.isExcludedPath(rel);
  }

  /** Absolute path of a workspace-relative path; throws when it would leave the root. */
  private inside(path: string): string {
    if (path !== ".") assertRelativePath(path);
    const abs = resolve(this.root, path);
    if (!this.contains(abs)) throw new CodeSearchWorkspaceError(`path outside the workspace: ${path}`);
    return abs;
  }

  private contains(abs: string): boolean {
    const rel = relative(this.root, abs);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  }
}

/** Run ripgrep with a byte cap, a time limit and abort support. */
export function runRipgrep(
  rgPath: string,
  argv: readonly string[],
  options: { cwd: string; timeoutMs: number; maxStdoutBytes: number; signal?: AbortSignal },
): Promise<CodeSearchRipgrepResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  return new Promise<CodeSearchRipgrepResult>((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(rgPath, [...argv], {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      reject(spawnError(rgPath, error));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killed = false;
    const kill = () => {
      killed = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, Math.max(1, options.timeoutMs));
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > options.maxStdoutBytes) {
        truncated = true;
        kill();
      }
    });
    child.on("error", (error) => finish(() => reject(spawnError(rgPath, error))));
    const settle = (code: number | null) => {
      finish(() => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        let bytes: Uint8Array = Buffer.concat(chunks, size);
        if (truncated) bytes = cutAtRecordBoundary(bytes, options.maxStdoutBytes);
        resolvePromise({
          stdout: new TextDecoder().decode(bytes),
          // A cut stream had output, so ripgrep found matches; a timed-out one has no status.
          exitCode: timedOut ? null : truncated ? 0 : code,
          truncated,
          timedOut,
        });
      });
    };
    child.on("close", (code) => settle(code));
    // After a kill, do not wait for the pipe to close: a process that inherited it could hold it open.
    child.on("exit", (code) => {
      if (!killed) return;
      child.stdout?.destroy();
      settle(code);
    });
  });
}

function spawnError(rgPath: string, error: unknown): Error {
  const code = (error as { code?: string }).code;
  if (code === "ENOENT") {
    return new CodeSearchRipgrepMissingError(`ripgrep (rg) is not installed (not found: ${rgPath})`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CodeSearchWorkspaceError(`ripgrep failed to start: ${message}`);
}
