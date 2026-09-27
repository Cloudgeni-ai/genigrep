/**
 * The MCP protocol core (src/mcp/protocol.ts) against the MCP SDK: version negotiation, ping, unknown
 * methods, client cancellation and the stdio framing. The SDK is a dev dependency only; genigrep does not
 * load it at runtime.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { MCP_PROTOCOL_VERSIONS, StdioTransport, type JsonRpcMessage } from "../src/mcp/protocol";
import { createGenigrepMcpServer } from "../src/mcp/server";
import { findRipgrep } from "../src/ripgrep";
import { makeFixtureRepo } from "./engine/helpers/fixture";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const repo = makeFixtureRepo();
dirs.push(repo);
const cfg = mkdtempSync(join(tmpdir(), "genigrep-mcp-protocol-cfg-"));
dirs.push(cfg);
const env = { XDG_CONFIG_HOME: cfg, PATH: process.env.PATH, GENIGREP_JEV_API_KEY: "protocol-test-key-1" };

/** A raw client end: send JSON-RPC messages and collect what the server answers. */
async function raw() {
  const server = createGenigrepMcpServer({ env, cwd: repo });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const received: JsonRpcMessage[] = [];
  clientEnd.onmessage = (m) => {
    received.push(m as JsonRpcMessage);
  };
  await clientEnd.start();
  await server.connect(serverEnd);
  const next = async (id: number | string) => {
    for (let i = 0; i < 200; i++) {
      const hit = received.find((m) => m.id === id);
      if (hit) return hit;
      await Bun.sleep(5);
    }
    throw new Error(`no response to ${id}`);
  };
  return {
    send: (m: Record<string, unknown>) => clientEnd.send({ jsonrpc: "2.0", ...m } as never),
    next,
    received,
    close: () => server.close(),
  };
}

describe("MCP protocol core", () => {
  test("speaks every protocol version the SDK supports and answers the newest otherwise", async () => {
    expect([...MCP_PROTOCOL_VERSIONS].sort()).toEqual([...SUPPORTED_PROTOCOL_VERSIONS].sort());
    expect(MCP_PROTOCOL_VERSIONS[0]).toBe(LATEST_PROTOCOL_VERSION);
    const s = await raw();
    try {
      const init = { capabilities: {}, clientInfo: { name: "t", version: "0" } };
      await s.send({ id: 1, method: "initialize", params: { ...init, protocolVersion: "2024-11-05" } });
      expect((await s.next(1)).result).toMatchObject({ protocolVersion: "2024-11-05", serverInfo: { name: "genigrep" } });
      await s.send({ id: 2, method: "initialize", params: { ...init, protocolVersion: "1999-01-01" } });
      expect((await s.next(2)).result).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSIONS[0] });
    } finally {
      await s.close();
    }
  });

  test("answers ping and reports unknown methods", async () => {
    const s = await raw();
    try {
      await s.send({ id: "p", method: "ping" });
      expect((await s.next("p")).result).toEqual({});
      await s.send({ id: 7, method: "resources/list", params: {} });
      expect((await s.next(7)).error).toMatchObject({ code: -32601 });
      await s.send({ id: 8, method: "tools/call", params: { name: "code_search", arguments: [1] } });
      expect((await s.next(8)).error).toMatchObject({ code: -32602 });
      // A notification it does not know is ignored.
      await s.send({ method: "notifications/whatever", params: {} });
      await s.send({ id: 9, method: "ping" });
      expect((await s.next(9)).result).toEqual({});
    } finally {
      await s.close();
    }
  });

  (findRipgrep() ? test : test.skip)("a cancelled call stops its Jev requests and gets no answer", async () => {
    let started = 0;
    let aborted = 0;
    const hangingJev = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init.method === "GET") {
          _resolve(new Response("{}"));
          return;
        }
        started++;
        init.signal?.addEventListener("abort", () => {
          aborted++;
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });
    const server = createGenigrepMcpServer({ env, cwd: repo, fetch: hangingJev });
    const client = new Client({ name: "t", version: "0" });
    const [c, sv] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(c), server.connect(sv)]);
    try {
      const controller = new AbortController();
      const call = client.callTool(
        { name: "code_search", arguments: { question: "How is the compaction threshold computed?", keywords: ["compactionThresholdTokens"] } },
        undefined,
        { signal: controller.signal },
      );
      for (let i = 0; i < 400 && started === 0; i++) await Bun.sleep(5);
      expect(started).toBeGreaterThan(0);
      controller.abort("user stopped it");
      await expect(call).rejects.toThrow();
      for (let i = 0; i < 400 && aborted < started; i++) await Bun.sleep(5);
      expect(aborted).toBe(started);
      expect(await client.ping()).toEqual({});
    } finally {
      await client.close();
      await server.close();
    }
  }, 30_000);
});

describe("stdio transport", () => {
  test("frames newline-delimited JSON, tolerates CRLF and skips lines that are not JSON", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const t = new StdioTransport(input, output);
    const messages: JsonRpcMessage[] = [];
    const errors: string[] = [];
    t.onmessage = (m) => {
      messages.push(m);
    };
    t.onerror = (e) => {
      errors.push(e.message);
    };
    await t.start();
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\r\n{"jsonrpc":"2.0",');
    input.write('"method":"notifications/initialized"}\nnot json\n\n');
    await Bun.sleep(5);
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(errors).toEqual(["received a line that is not JSON; ignored"]);
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    await t.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(written).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    let closed = false;
    t.onclose = () => {
      closed = true;
    };
    await t.close();
    expect(closed).toBe(true);
  });
});
