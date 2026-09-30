import { CODE_SEARCH_CREDENTIAL_DIRS, isCodeSearchCredentialPath } from "../engine/code-search/recall";

/**
 * Paths genigrep never searches or reads, on top of the engine's built-in excludes (node_modules, dist,
 * build, target, vendor, .git, lock files, minified and generated files, images and archives) and on top of
 * .gitignore, .ignore and .rgignore files, which ripgrep honours.
 *
 * Secret files are excluded twice: as case-insensitive ripgrep globs (`--iglob`), so no matching line is
 * ever sent to Jev as a file triage hit, and by `isSecretPath`, so an explicitly named path, or a link to
 * one, is neither searched nor read (ripgrep searches explicitly named files even when a glob excludes them).
 * Matching ignores case, so `.ENV` or `Server.PEM` count too, also on case-sensitive file systems.
 */

/**
 * Files that usually hold credentials, as ripgrep globs matched without regard to case. Example and template
 * env files (.env.example) stay searchable. Every glob matches files only by a specific name: a glob such as
 * `credentials` alone would also prune source directories of that name.
 */
export const SECRET_EXCLUDE_GLOBS: readonly string[] = [
  "!**/.env",
  "!**/.env.local",
  "!**/.env.*.local",
  "!**/.env.{prod,production,prd,live,dev,development,staging,stage,stg,test,qa,uat,ci,preview,backup,bak,old}",
  "!**/.envrc",
  "!**/.netrc",
  "!**/.npmrc",
  "!**/.yarnrc.yml",
  "!**/.pypirc",
  "!**/.pgpass",
  "!**/.htpasswd",
  "!**/.git-credentials",
  "!**/.vault-token",
  "!**/.s3cfg",
  "!**/.boto",
  "!**/.dockercfg",
  "!**/id_{rsa,dsa,ecdsa,ed25519}",
  "!**/id_{rsa,dsa,ecdsa,ed25519}.*",
  "!**/*.{pem,key,p8,p12,pfx,jks,keystore,kdbx,ovpn,ppk}",
  "!**/*.tfstate",
  "!**/*.tfstate.*",
  "!**/*.tfvars",
  "!**/*.tfvars.json",
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
  "!**/gh/hosts.yml",
  "!**/.gem/credentials",
  "!**/.cargo/credentials",
  "!**/.cargo/credentials.toml",
  // platform credential directories (.opengeni, .azure, .config/opengeni), also excluded by the engine
  ...CODE_SEARCH_CREDENTIAL_DIRS.map((dir) => `!**/${dir.join("/")}/**`),
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
  ".vault-token",
  ".s3cfg",
  ".boto",
  ".dockercfg",
]);
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env\.(.+\.local|prod|production|prd|live|dev|development|staging|stage|stg|test|qa|uat|ci|preview|backup|bak|old)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/,
  /\.(pem|key|p8|p12|pfx|jks|keystore|kdbx|ovpn|ppk)$/,
  /\.tfstate(\..*)?$/,
  /\.tfvars(\.json)?$/,
  /^secrets?\.(yml|yaml|json|toml|env|ini)$/,
  /credentials.*\.json$/,
  /service[-_]account.*\.json$/,
];
/** Secret files known by their directory and name. */
const SECRET_FILES_IN: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [".docker", new Set(["config.json"])],
  ["gh", new Set(["hosts.yml"])],
  [".gem", new Set(["credentials"])],
  [".cargo", new Set(["credentials", "credentials.toml"])],
]);
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube"]);

/** Lower-cased path segments, without empty and "." segments. */
function segments(path: string): string[] {
  return path
    .split(/[\\/]+/)
    .filter((p) => p && p !== ".")
    .map((p) => p.toLowerCase());
}

/**
 * True for a workspace-relative path that SECRET_EXCLUDE_GLOBS excludes, or that lies in a credentials
 * directory (including the platform credential directories `.opengeni`, `.azure` and `.config/opengeni`).
 * Matching ignores case, like the `--iglob` globs.
 */
export function isSecretPath(relPath: string): boolean {
  const parts = segments(relPath);
  const name = parts[parts.length - 1];
  if (!name) return false;
  if (parts.some((part) => SECRET_DIRS.has(part))) return true;
  if (isCodeSearchCredentialPath(parts.join("/"))) return true;
  const parent = parts[parts.length - 2];
  if (parent !== undefined && SECRET_FILES_IN.get(parent)?.has(name)) return true;
  if (SECRET_NAMES.has(name)) return true;
  return SECRET_NAME_PATTERNS.some((re) => re.test(name));
}

/**
 * True for a directory that is, or lies inside, a credentials directory (`.ssh`, `.aws`, `.gnupg`, `.kube`,
 * `.opengeni`, `.azure`, `.config/opengeni`).
 * The exclude globs match paths relative to the searched directory, so a search rooted inside one of these
 * would not see the directory name; LocalWorkspace refuses such a root instead.
 */
export function isSecretDirectory(path: string): boolean {
  const parts = segments(path);
  return parts.some((part) => SECRET_DIRS.has(part)) || isCodeSearchCredentialPath(parts.join("/"));
}
