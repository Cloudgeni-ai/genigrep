/** The structured result fields and header name that genigrep added on top of the ported engine. */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runCodeSearch } from "../../src/engine";
import { findRipgrep } from "../../src/ripgrep";
import { fakeJevClient, makeFixtureRepo, packPassages } from "./helpers/fixture";
import { LocalCodeSearchWorkspace } from "./helpers/local-workspace";

const describeWithRipgrep = findRipgrep() ? describe : describe.skip;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const question = "How is the compaction token threshold computed and when does a turn compact?";
const keywords = ["compactionThresholdTokens", "compactNow", "contextWindow", "threshold"];

describeWithRipgrep("structured result", () => {
  test("passages mirror the rendered pack, in the same order", async () => {
    const root = makeFixtureRepo();
    roots.push(root);
    const r = await runCodeSearch({
      question,
      keywords,
      subQuestions: ["How is the threshold computed?", "When does a turn compact?"],
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient(),
    });
    const rendered = packPassages(r.text);
    expect(r.passages.length).toBe(rendered.length);
    expect(r.passages.length).toBeGreaterThan(0);
    r.passages.forEach((p, i) => {
      expect(p.path).toBe(rendered[i]!.path);
      expect(p.start).toBe(rendered[i]!.start);
      expect(p.end).toBe(rendered[i]!.end);
      expect(p.lines.split("\n")).toEqual(rendered[i]!.lines);
      expect(p.coverage.length).toBe(2);
      expect(p.rel).toBeGreaterThanOrEqual(0);
    });
    expect(r.text.startsWith("code_search: ")).toBe(true);
    expect(Array.isArray(r.leads.leadsNotFollowed)).toBe(true);
    expect(Array.isArray(r.leads.morePassages)).toBe(true);
  });

  test("headerName renames the status header only", async () => {
    const root = makeFixtureRepo();
    roots.push(root);
    const base = { question, keywords, jev: fakeJevClient() };
    const a = await runCodeSearch({ ...base, workspace: new LocalCodeSearchWorkspace(root) });
    const b = await runCodeSearch({
      ...base,
      workspace: new LocalCodeSearchWorkspace(root),
      headerName: "genigrep",
    });
    expect(b.text.startsWith("genigrep: ")).toBe(true);
    const strip = (t: string) => t.split("\n").slice(1).join("\n");
    expect(strip(b.text)).toBe(strip(a.text));
  });

  test("zero-hit keywords are reported as data", async () => {
    const root = makeFixtureRepo();
    roots.push(root);
    const r = await runCodeSearch({
      question,
      keywords: [...keywords, "noSuchIdentifierAnywhere"],
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient(),
    });
    expect(r.leads.zeroHitKeywords.map((k) => k.keyword)).toContain("noSuchIdentifierAnywhere");
  });
});
