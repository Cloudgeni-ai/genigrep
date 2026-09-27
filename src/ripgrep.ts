/**
 * Locate the ripgrep binary: GENIGREP_RG_PATH, then the binary shipped by the @vscode/ripgrep npm
 * package, then `rg` on PATH.
 */
import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, join } from "node:path";

export type RipgrepSource = "env" | "bundled" | "system";

export interface RipgrepBinary {
  path: string;
  source: RipgrepSource;
}

const EXE = process.platform === "win32" ? "rg.exe" : "rg";

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The binary from @vscode/ripgrep. The package installs a per-platform optional dependency
 * (`@vscode/ripgrep-<platform>-<arch>`), resolved here the same way the package itself does, without
 * importing it (its entry point throws when the platform package is missing). It is resolved from
 * @vscode/ripgrep's own location first, because strict layouts (pnpm) do not hoist it next to genigrep.
 */
export function bundledRipgrepPath(): string | null {
  const require = createRequire(import.meta.url);
  const arch = process.env.npm_config_arch || process.arch;
  const target = `@vscode/ripgrep-${process.platform}-${arch}/bin/${EXE}`;
  const resolvers: Array<() => string> = [
    () => createRequire(require.resolve("@vscode/ripgrep")).resolve(target),
    () => require.resolve(target),
  ];
  for (const resolveBinary of resolvers) {
    try {
      const path = resolveBinary();
      if (isExecutableFile(path)) return path;
    } catch {
      // try the next way
    }
  }
  return null;
}

/** First `rg` on PATH. */
export function systemRipgrepPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, EXE);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** The ripgrep to run, or null when none is available. GENIGREP_RG_PATH wins even when it is wrong, so a bad override fails loudly. */
export function findRipgrep(env: NodeJS.ProcessEnv = process.env): RipgrepBinary | null {
  const override = env.GENIGREP_RG_PATH?.trim();
  if (override) {
    return { path: isAbsolute(override) ? override : join(process.cwd(), override), source: "env" };
  }
  const bundled = bundledRipgrepPath();
  if (bundled) return { path: bundled, source: "bundled" };
  const system = systemRipgrepPath(env);
  if (system) return { path: system, source: "system" };
  return null;
}
