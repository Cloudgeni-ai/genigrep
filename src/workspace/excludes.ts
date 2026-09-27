/**
 * Paths genigrep never searches or reads, on top of the engine's built-in excludes (node_modules, dist,
 * build, target, vendor, .git, lock files, minified and generated files, images and archives) and on top of
 * .gitignore, .ignore and .rgignore files, which ripgrep honours.
 *
 * Secret files are excluded twice: as ripgrep globs, so no matching line is ever sent to Jev as a file
 * triage hit, and by `isSecretPath`, so an explicitly named path is neither searched nor read (ripgrep
 * searches explicitly named files even when a glob excludes them).
 */

/** Files that usually hold credentials. Example and template env files (.env.example) stay searchable. */
export const SECRET_EXCLUDE_GLOBS: readonly string[] = [
  "!**/.env",
  "!**/.env.local",
  "!**/.env.*.local",
  "!**/.env.{prod,production,dev,development,staging,stage,test,ci,preview}",
  "!**/.envrc",
  "!**/.netrc",
  "!**/.npmrc",
  "!**/.yarnrc.yml",
  "!**/.pypirc",
  "!**/.pgpass",
  "!**/.htpasswd",
  "!**/.git-credentials",
  "!**/id_{rsa,dsa,ecdsa,ed25519}",
  "!**/id_{rsa,dsa,ecdsa,ed25519}.*",
  "!**/*.{pem,key,p12,pfx,jks,keystore,kdbx,ovpn,ppk}",
  "!**/*.tfstate",
  "!**/*.tfstate.*",
  "!**/*.tfvars",
  "!**/secret.{yml,yaml,json,toml,env,ini}",
  "!**/secrets.{yml,yaml,json,toml,env,ini}",
  "!**/*credentials*.json",
  "!**/*service-account*.json",
  "!**/*service_account*.json",
  "!**/.ssh/**",
  "!**/.aws/**",
  "!**/.gnupg/**",
  "!**/.kube/**",
  "!**/.docker/config.json",
];

/** Dependency, virtualenv and cache directories the engine's built-in list does not cover. */
export const DEPENDENCY_EXCLUDE_GLOBS: readonly string[] = [
  "!**/.venv/**",
  "!**/venv/**",
  "!**/site-packages/**",
  "!**/__pycache__/**",
  "!**/.tox/**",
  "!**/.nox/**",
  "!**/.mypy_cache/**",
  "!**/.pytest_cache/**",
  "!**/.ruff_cache/**",
  "!**/.gradle/**",
  "!**/Pods/**",
  "!**/bower_components/**",
  "!**/jspm_packages/**",
  "!**/.yarn/**",
  "!**/.pnpm-store/**",
  "!**/.terraform/**",
  "!**/.nuxt/**",
  "!**/.svelte-kit/**",
  "!**/.parcel-cache/**",
  "!**/.angular/**",
  "!**/.dart_tool/**",
  "!**/.bundle/**",
  "!**/elm-stuff/**",
  "!**/.cache/**",
];

export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  ...SECRET_EXCLUDE_GLOBS,
  ...DEPENDENCY_EXCLUDE_GLOBS,
];

const SECRET_NAMES = new Set([
  ".env",
  ".env.local",
  ".envrc",
  ".netrc",
  ".npmrc",
  ".yarnrc.yml",
  ".pypirc",
  ".pgpass",
  ".htpasswd",
  ".git-credentials",
]);
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env\.(.+\.local|prod|production|dev|development|staging|stage|test|ci|preview)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|ppk)$/,
  /\.tfstate(\..*)?$/,
  /\.tfvars$/,
  /^secrets?\.(yml|yaml|json|toml|env|ini)$/,
  /credentials.*\.json$/,
  /service[-_]account.*\.json$/,
];
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube"]);

/**
 * True for a workspace-relative path that SECRET_EXCLUDE_GLOBS excludes. Matching is case-sensitive, like
 * ripgrep's globs on Linux.
 */
export function isSecretPath(relPath: string): boolean {
  const parts = relPath.split(/[\\/]+/).filter((p) => p && p !== ".");
  const name = parts[parts.length - 1];
  if (!name) return false;
  if (parts.some((part) => SECRET_DIRS.has(part))) return true;
  if (name === "config.json" && parts[parts.length - 2] === ".docker") return true;
  if (SECRET_NAMES.has(name)) return true;
  return SECRET_NAME_PATTERNS.some((re) => re.test(name));
}
