import { describe, expect, test } from "bun:test";
import { UsageError, parseCommand } from "../src/cli/args";

describe("parseCommand", () => {
  test("a question and an optional path", () => {
    expect(parseCommand(["Where is X decided?"])).toEqual({
      kind: "search",
      question: "Where is X decided?",
      target: undefined,
      keywords: [],
      subQuestions: [],
      paths: [],
      budget: undefined,
      json: false,
      verbose: false,
      quiet: false,
    });
    const c = parseCommand(["Where is X decided?", "../repo"]);
    expect(c.kind === "search" && c.target).toBe("../repo");
  });

  test("keywords repeat and split on commas; sub-questions and --in repeat", () => {
    const c = parseCommand([
      "How is the retry delay computed?",
      ".",
      "-k",
      "retryDelay, backoff",
      "--keyword",
      "RETRY_MAX",
      "-k",
      ",",
      "-s",
      "What caps the delay?",
      "--sub",
      "Which errors retry?",
      "--in",
      "src",
      "--in",
      "lib/net",
      "-b",
      "8000",
      "--json",
    ]);
    expect(c).toMatchObject({
      kind: "search",
      keywords: ["retryDelay", "backoff", "RETRY_MAX"],
      subQuestions: ["What caps the delay?", "Which errors retry?"],
      paths: ["src", "lib/net"],
      budget: 8000,
      json: true,
    });
  });

  test("an explicit search subcommand searches for a word that is also a command", () => {
    expect(parseCommand(["search", "doctor"])).toMatchObject({ kind: "search", question: "doctor" });
  });

  test("options may come before the question", () => {
    expect(parseCommand(["-v", "-k", "foo", "Where is foo?"])).toMatchObject({
      question: "Where is foo?",
      verbose: true,
      keywords: ["foo"],
    });
  });

  test("subcommands", () => {
    expect(parseCommand(["auth"])).toEqual({ kind: "auth", action: "save", verify: true });
    expect(parseCommand(["auth", "--no-verify"])).toEqual({ kind: "auth", action: "save", verify: false });
    expect(parseCommand(["auth", "--remove"])).toMatchObject({ action: "remove" });
    expect(parseCommand(["auth", "--status"])).toMatchObject({ action: "status" });
    expect(parseCommand(["doctor"])).toEqual({ kind: "doctor", json: false });
    expect(parseCommand(["doctor", "--json"])).toEqual({ kind: "doctor", json: true });
    expect(parseCommand(["--version"])).toEqual({ kind: "version" });
    expect(parseCommand(["-V"])).toEqual({ kind: "version" });
    expect(parseCommand([])).toEqual({ kind: "help", topic: "search" });
    expect(parseCommand(["--help"])).toEqual({ kind: "help", topic: "search" });
    expect(parseCommand(["help", "auth"])).toEqual({ kind: "help", topic: "auth" });
    expect(parseCommand(["auth", "--help"])).toEqual({ kind: "help", topic: "auth" });
    expect(parseCommand(["Where is it?", "-h"])).toEqual({ kind: "help", topic: "search" });
  });

  test("usage errors", () => {
    const bad: string[][] = [
      ["where", "is", "the", "thing"],
      ["-k", "foo"],
      ["Where?", "--frobnicate"],
      ["Where?", "-b", "lots"],
      ["Where?", "-v", "-q"],
      ["Where?", "-k"],
      ["auth", "--remove", "--status"],
      ["auth", "extra"],
      ["doctor", "--fix"],
    ];
    for (const argv of bad) expect(() => parseCommand(argv)).toThrow(UsageError);
  });
});
