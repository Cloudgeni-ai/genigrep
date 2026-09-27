/**
 * Settings: the Jev API key and endpoint. Environment variables win over the config file, which lives in
 * the XDG config directory with mode 0600. The key is never printed or logged.
 */
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { JEV_DEFAULT_BASE_URL, JEV_DEFAULT_MODEL } from "./engine";

export const ENV_API_KEY = "GENIGREP_JEV_API_KEY";
export const ENV_BASE_URL = "GENIGREP_JEV_BASE_URL";
export const ENV_MODEL = "GENIGREP_JEV_MODEL";
export const ENV_TIMEOUT_MS = "GENIGREP_JEV_TIMEOUT_MS";

/** Jev per-request timeout; the engine's tuning assumed 10 s. */
export const DEFAULT_JEV_TIMEOUT_MS = 10_000;
export const MAX_JEV_TIMEOUT_MS = 120_000;

export interface StoredConfig {
  jevApiKey?: string;
  jevBaseUrl?: string;
  jevModel?: string;
}

export type ApiKeySource = "env" | "config";

export interface Settings {
  apiKey: string | null;
  apiKeySource: ApiKeySource | null;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  configPath: string;
  /** Problems worth telling the user about (never contains the key). */
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** `$XDG_CONFIG_HOME/genigrep`, `%APPDATA%\genigrep` on Windows, else `~/.config/genigrep`. */
export function configDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg && isAbsolute(xdg)) return join(xdg, "genigrep");
  const appData = env.APPDATA?.trim();
  if (platform === "win32" && appData) return join(appData, "genigrep");
  return join(home, ".config", "genigrep");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

/** Shape check for an API key; says nothing about whether Jev accepts it. */
export function checkApiKeyShape(key: string): string | null {
  if (!key) return "the key is empty";
  if (key.length < 8) return "the key is too short";
  if (key.length > 1024) return "the key is too long";
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return "the key contains whitespace or control characters";
  return null;
}

/**
 * The key is sent as a bearer token, so only HTTPS is accepted, except plain HTTP to this machine (for tests
 * and local proxies).
 */
export function checkBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("the Jev base URL is not a valid URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConfigError("the Jev base URL must use https (plain http is allowed only for localhost)");
  }
  return raw.replace(/\/+$/, "");
}

export async function readConfig(path: string): Promise<{ config: StoredConfig; mode: number | null }> {
  let text: string;
  let mode: number | null = null;
  try {
    const st = await stat(path);
    mode = st.mode & 0o777;
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { config: {}, mode: null };
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }
  const raw = parsed as Record<string, unknown>;
  const config: StoredConfig = {};
  for (const key of ["jevApiKey", "jevBaseUrl", "jevModel"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== "string") throw new ConfigError(`${path}: ${key} must be a string`);
    config[key] = v;
  }
  return { config, mode };
}

/** Write the config atomically with mode 0600, in a directory with mode 0700. */
export async function writeConfig(path: string, config: StoredConfig): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(JSON.stringify(config, null, 2) + "\n", "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await chmod(path, 0o600);
}

/** Store the key, keeping any other settings in the file. */
export async function saveApiKey(path: string, apiKey: string): Promise<void> {
  const shape = checkApiKeyShape(apiKey);
  if (shape) throw new ConfigError(shape);
  const { config } = await readConfig(path);
  await writeConfig(path, { ...config, jevApiKey: apiKey });
}

/** Remove the stored key. Returns false when there was none. */
export async function removeApiKey(path: string): Promise<boolean> {
  const { config } = await readConfig(path);
  if (config.jevApiKey === undefined) return false;
  const { jevApiKey: _removed, ...rest } = config;
  if (Object.keys(rest).length) await writeConfig(path, rest);
  else await unlink(path);
  return true;
}

/** Resolve settings from the environment and the config file. */
export async function loadSettings(env: NodeJS.ProcessEnv = process.env): Promise<Settings> {
  const path = configPath(env);
  const warnings: string[] = [];
  const { config, mode } = await readConfig(path);
  if (mode !== null && process.platform !== "win32" && (mode & 0o077) !== 0) {
    warnings.push(
      `${path} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${path}`,
    );
  }
  const envKey = env[ENV_API_KEY]?.trim();
  const fileKey = config.jevApiKey?.trim();
  const apiKey = envKey || fileKey || null;
  const apiKeySource: ApiKeySource | null = envKey ? "env" : fileKey ? "config" : null;
  const baseUrl = checkBaseUrl(env[ENV_BASE_URL]?.trim() || config.jevBaseUrl || JEV_DEFAULT_BASE_URL);
  const model = env[ENV_MODEL]?.trim() || config.jevModel || JEV_DEFAULT_MODEL;
  let timeoutMs = DEFAULT_JEV_TIMEOUT_MS;
  const rawTimeout = env[ENV_TIMEOUT_MS]?.trim();
  if (rawTimeout) {
    const n = Number(rawTimeout);
    if (!Number.isInteger(n) || n < 1000 || n > MAX_JEV_TIMEOUT_MS) {
      throw new ConfigError(`${ENV_TIMEOUT_MS} must be an integer from 1000 to ${MAX_JEV_TIMEOUT_MS}`);
    }
    timeoutMs = n;
  }
  return { apiKey, apiKeySource, baseUrl, model, timeoutMs, configPath: path, warnings };
}
