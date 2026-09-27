/**
 * genigrep as a library: `genigrep()` searches a local directory; the engine, the Jev client and the
 * workspace adapter are exported for hosts that wire code search into their own agent tools.
 */
export { genigrep, MAX_BUDGET_TOKENS, MIN_BUDGET_TOKENS, type GenigrepOptions, type GenigrepResult } from "./genigrep";
export { deriveKeywords, type DeriveKeywordsOptions } from "./keywords";
export {
  LocalWorkspace,
  LOCAL_MAX_PATTERN_CHARS,
  LOCAL_MAX_READ_BYTES,
  LOCAL_RIPGREP_MAX_STDOUT_BYTES,
  runRipgrep,
  validateRipgrepArgs,
  type LocalWorkspaceOptions,
} from "./workspace/local";
export {
  DEFAULT_EXCLUDE_GLOBS,
  DEPENDENCY_EXCLUDE_GLOBS,
  SECRET_EXCLUDE_GLOBS,
  isSecretDirectory,
  isSecretPath,
} from "./workspace/excludes";
export { findRipgrep, type RipgrepBinary, type RipgrepSource } from "./ripgrep";
export {
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_MODEL,
  ENV_TIMEOUT_MS,
  configPath,
  loadSettings,
  type Settings,
} from "./config";
export { VERSION } from "./version";
export * from "./engine";
