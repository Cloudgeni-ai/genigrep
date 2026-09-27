import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  checkApiKeyShape,
  checkBaseUrl,
  configDir,
  configPath,
  loadSettings,
  removeApiKey,
  saveApiKey,
} from "../src/config";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "genigrep-config-"));
  dirs.push(d);
  return d;
}

const KEY = "test-key-0123456789";
const posix = process.platform !== "win32";

describe("config location", () => {
  test("XDG_CONFIG_HOME, APPDATA on Windows, else ~/.config", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x/cfg" }, "linux", "/home/u")).toBe("/x/cfg/genigrep");
    expect(configDir({ XDG_CONFIG_HOME: "relative" }, "linux", "/home/u")).toBe("/home/u/.config/genigrep");
    expect(configDir({}, "darwin", "/Users/u")).toBe("/Users/u/.config/genigrep");
    expect(configDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u")).toContain("genigrep");
  });
});

describe("storing the key", () => {
  test("saves with mode 0600 in a 0700 directory and keeps other settings", async () => {
    const home = tempHome();
    const env = { XDG_CONFIG_HOME: home };
    const path = configPath(env);
    mkdirSync(join(home, "genigrep"), { recursive: true });
    writeFileSync(path, JSON.stringify({ jevModel: "jev-custom" }));
    await saveApiKey(path, KEY);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored).toEqual({ jevModel: "jev-custom", jevApiKey: KEY });
    if (posix) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const s = await loadSettings(env);
    expect(s.apiKey).toBe(KEY);
    expect(s.apiKeySource).toBe("config");
    expect(s.model).toBe("jev-custom");
    expect(s.warnings).toEqual([]);
  });

  test("creates the directory with mode 0700", async () => {
    const home = tempHome();
    const path = configPath({ XDG_CONFIG_HOME: home });
    await saveApiKey(path, KEY);
    if (posix) expect(statSync(join(home, "genigrep")).mode & 0o777).toBe(0o700);
  });

  test("the environment wins over the file", async () => {
    const home = tempHome();
    await saveApiKey(configPath({ XDG_CONFIG_HOME: home }), KEY);
    const s = await loadSettings({ XDG_CONFIG_HOME: home, GENIGREP_JEV_API_KEY: "env-key-abcdefgh" });
    expect(s.apiKey).toBe("env-key-abcdefgh");
    expect(s.apiKeySource).toBe("env");
  });

  test("warns when the file is readable by others, without printing the key", async () => {
    if (!posix) return;
    const home = tempHome();
    const path = configPath({ XDG_CONFIG_HOME: home });
    await saveApiKey(path, KEY);
    chmodSync(path, 0o644);
    const s = await loadSettings({ XDG_CONFIG_HOME: home });
    expect(s.warnings.length).toBe(1);
    expect(s.warnings[0]).toContain("chmod 600");
    expect(s.warnings[0]).not.toContain(KEY);
  });

  test("remove deletes the key and the file when nothing else is left", async () => {
    const home = tempHome();
    const path = configPath({ XDG_CONFIG_HOME: home });
    await saveApiKey(path, KEY);
    expect(await removeApiKey(path)).toBe(true);
    expect(await removeApiKey(path)).toBe(false);
    expect((await loadSettings({ XDG_CONFIG_HOME: home })).apiKey).toBeNull();
  });

  test("rejects malformed keys and config files", async () => {
    expect(checkApiKeyShape("")).not.toBeNull();
    expect(checkApiKeyShape("short")).not.toBeNull();
    expect(checkApiKeyShape("has space inside")).not.toBeNull();
    expect(checkApiKeyShape(KEY)).toBeNull();
    const home = tempHome();
    const path = configPath({ XDG_CONFIG_HOME: home });
    mkdirSync(join(home, "genigrep"), { recursive: true });
    writeFileSync(path, "{not json");
    await expect(loadSettings({ XDG_CONFIG_HOME: home })).rejects.toBeInstanceOf(ConfigError);
    writeFileSync(path, JSON.stringify({ jevApiKey: 42 }));
    await expect(loadSettings({ XDG_CONFIG_HOME: home })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("endpoint settings", () => {
  test("https only, except plain http to localhost", () => {
    expect(checkBaseUrl("https://api.typesafe.ai/")).toBe("https://api.typesafe.ai");
    expect(checkBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(checkBaseUrl("http://localhost:1")).toBe("http://localhost:1");
    expect(() => checkBaseUrl("http://jev.example.com")).toThrow(ConfigError);
    expect(() => checkBaseUrl("not a url")).toThrow(ConfigError);
  });

  test("timeout bounds", async () => {
    const home = tempHome();
    expect((await loadSettings({ XDG_CONFIG_HOME: home, GENIGREP_JEV_TIMEOUT_MS: "30000" })).timeoutMs).toBe(30_000);
    await expect(loadSettings({ XDG_CONFIG_HOME: home, GENIGREP_JEV_TIMEOUT_MS: "5" })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});
