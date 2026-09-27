import { describe, expect, test } from "bun:test";
import { deriveKeywords } from "../src/keywords";

describe("deriveKeywords", () => {
  test("content-word pairs, then single words trimmed to a matching prefix", () => {
    expect(deriveKeywords("Where is the Codex usage limit error classified?")).toEqual([
      "codex usage",
      "usage limit",
      "limit error",
      "codex",
      "usage",
      "limit",
      "error",
      "classif",
    ]);
  });

  test("quoted strings and identifiers are kept verbatim and come first", () => {
    expect(
      deriveKeywords("Where is `OPENGENI_JEV_API_KEY` read and what happens with an invalid key?"),
    ).toEqual(["OPENGENI_JEV_API_KEY", "invalid key", "read", "invalid", "key"]);
    expect(deriveKeywords("Which function renders the 'No passage passed verification' message?")).toEqual([
      "No passage passed verification",
      "render",
      "message",
    ]);
    expect(deriveKeywords('where is "rate limited" logged in config.json or retryDelayMs?')).toEqual([
      "rate limited",
      "config.json",
      "retryDelayMs",
      "logged",
    ]);
  });

  test("status codes and acronyms count as identifiers", () => {
    expect(deriveKeywords("How are HTTP 429 responses retried?")).toEqual([
      "HTTP",
      "429",
      "responses retried",
      "respons",
      "retri",
    ]);
  });

  test("punctuation and meta words break phrases", () => {
    const k = deriveKeywords("how does the worker's circuit breaker open, and where is the cooldown?");
    expect(k).toContain("circuit breaker");
    expect(k).not.toContain("open cooldown");
    expect(k).toContain("cooldown");
  });

  test("respects the maximum and returns nothing for an empty question", () => {
    const long = "alpha bravo charlie delta echoes foxtrot golfing hotel india juliet kilos limas mikes";
    expect(deriveKeywords(long).length).toBe(12);
    expect(deriveKeywords(long, { max: 5 }).length).toBe(5);
    expect(deriveKeywords("where is it?")).toEqual([]);
  });
});
