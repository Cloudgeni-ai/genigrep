/** The agent skill: valid Agent Skills frontmatter, and the guidance OpenGeni's benchmarked wording carries. */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const skillsDir = join(import.meta.dir, "..", "skills");

function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("no frontmatter");
  const out: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`unexpected frontmatter line: ${line}`);
    out[kv[1]!] = kv[2]!;
  }
  return out;
}

describe("skills/genigrep", () => {
  const dirs = readdirSync(skillsDir);
  const text = readFileSync(join(skillsDir, "genigrep", "SKILL.md"), "utf8");
  const meta = frontmatter(text);

  test("has Agent Skills frontmatter whose name matches its directory", () => {
    expect(dirs).toEqual(["genigrep"]);
    expect(meta.name).toBe("genigrep");
    expect(meta.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(meta.description!.length).toBeGreaterThan(50);
    expect(meta.description!.length).toBeLessThanOrEqual(1024);
    expect((meta.compatibility ?? "").length).toBeLessThanOrEqual(500);
    expect(meta.description).toContain("Do not use it when you already know the symbol");
  });

  test("keeps the guidance that stopped agents from over-trusting the search", () => {
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("The evidence rating covers only what the search returned; it cannot see what the search missed.");
    expect(flat).toContain("Do not re-read the same line ranges");
    expect(flat).toContain("other entry points to the same outcome (API routes, automatic or self-service paths), defaults, flags, exceptions");
    expect(flat).toContain("Verify critical claims");
    expect(flat).toContain("6-15 keywords");
  });

  test("contains no em or en dashes", () => {
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
