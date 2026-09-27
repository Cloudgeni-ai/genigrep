/**
 * A minimal Model Context Protocol server core: JSON-RPC 2.0 over a message transport, with exactly the
 * methods genigrep needs (initialize, ping, tools/list, tools/call, client cancellation, and a roots/list
 * request to the client). It replaces the MCP SDK at runtime so installing genigrep does not pull in an
 * HTTP server stack; the tests drive it with the SDK's own client to check protocol compatibility.
 */

/** Protocol versions this server speaks, newest first. A client asking for another one gets the newest. */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

export const McpErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ConnectionClosed: -32000,
  RequestTimeout: -32001,
} as const;

export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export type JsonRpcId = string | number;

/** One JSON-RPC message as it travels over the transport. */
export type JsonRpcMessage = { [key: string]: unknown };

/**
 * A bidirectional message channel. The shape matches the MCP SDK's Transport interface, so the SDK's
 * in-memory transport works with this server as well as the stdio transport below.
 */
export interface McpTransport {
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?(message: JsonRpcMessage): void;
  onclose?(): void;
  onerror?(error: Error): void;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpRequestContext {
  /** Aborted when the client cancels the request or the connection closes. */
  signal: AbortSignal;
}

export type McpRequestHandler = (params: Record<string, unknown>, context: McpRequestContext) => Promise<unknown>;

/** What the client said about itself in initialize. */
export interface McpClientCapabilities {
  roots?: { listChanged?: boolean };
  [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export class McpServer {
  private transport: McpTransport | null = null;
  private clientCapabilities: McpClientCapabilities | undefined;
  private readonly handlers = new Map<string, McpRequestHandler>();
  private readonly notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
  private readonly inFlight = new Map<JsonRpcId, AbortController>();
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextId = 0;
  private closed = false;
  /** Called once when the connection closes. */
  onclose?: () => void;
  /** Transport and protocol problems that are not tied to one request. */
  onerror?: (error: Error) => void;

  constructor(
    private readonly info: McpServerInfo,
    private readonly options: { capabilities: Record<string, unknown>; instructions?: string | undefined },
  ) {
    this.handlers.set("initialize", async (params) => this.initialize(params));
    this.handlers.set("ping", async () => ({}));
    this.notificationHandlers.set("notifications/cancelled", (params) => {
      if (isId(params.requestId)) this.inFlight.get(params.requestId)?.abort(params.reason);
    });
  }

  /** Handle a request method; the handler's return value is the result, a thrown McpError its error. */
  setRequestHandler(method: string, handler: McpRequestHandler): void {
    this.handlers.set(method, handler);
  }

  setNotificationHandler(method: string, handler: (params: Record<string, unknown>) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /** The client's capabilities from initialize (undefined before it). */
  getClientCapabilities(): McpClientCapabilities | undefined {
    return this.clientCapabilities;
  }

  async connect(transport: McpTransport): Promise<void> {
    this.transport = transport;
    transport.onmessage = (message: JsonRpcMessage) => this.receive(message);
    transport.onerror = (error: Error) => this.onerror?.(error);
    transport.onclose = () => this.closedByTransport();
    await transport.start();
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.closedByTransport();
  }

  /** Send a request to the client and wait for its result. */
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const transport = this.transport;
    if (!transport || this.closed) return Promise.reject(new McpError(McpErrorCode.ConnectionClosed, "Connection closed"));
    const id = `genigrep-${++this.nextId}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(McpErrorCode.RequestTimeout, `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      transport.send({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private initialize(params: Record<string, unknown>) {
    const requested = params.protocolVersion;
    this.clientCapabilities = isObject(params.capabilities) ? (params.capabilities as McpClientCapabilities) : {};
    const protocolVersion =
      typeof requested === "string" && MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
    return {
      protocolVersion,
      capabilities: this.options.capabilities,
      serverInfo: this.info,
      ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
    };
  }

  private receive(message: JsonRpcMessage): void {
    if (!isObject(message)) return;
    const { id, method } = message;
    if (typeof method === "string") {
      const params = isObject(message.params) ? message.params : {};
      if (id === undefined) {
        try {
          this.notificationHandlers.get(method)?.(params);
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (isId(id)) void this.handleRequest(id, method, params);
      return;
    }
    if (isId(id)) {
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      if (isObject(message.error)) {
        const code = typeof message.error.code === "number" ? message.error.code : McpErrorCode.InternalError;
        const text = typeof message.error.message === "string" ? message.error.message : "request failed";
        waiter.reject(new McpError(code, text));
      } else {
        waiter.resolve(message.result);
      }
    }
  }

  private async handleRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    const handler = this.handlers.get(method);
    if (!handler) {
      await this.send(transport, {
        jsonrpc: "2.0",
        id,
        error: { code: McpErrorCode.MethodNotFound, message: "Method not found" },
      });
      return;
    }
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    try {
      const result = await handler(params, { signal: controller.signal });
      // A cancelled request gets no response.
      if (!controller.signal.aborted) await this.send(transport, { jsonrpc: "2.0", id, result });
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof McpError ? error.code : McpErrorCode.InternalError;
      const text = error instanceof Error ? error.message : "Internal error";
      await this.send(transport, { jsonrpc: "2.0", id, error: { code, message: text } });
    } finally {
      if (this.inFlight.get(id) === controller) this.inFlight.delete(id);
    }
  }

  private async send(transport: McpTransport, message: JsonRpcMessage): Promise<void> {
    try {
      await transport.send(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private closedByTransport(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new McpError(McpErrorCode.ConnectionClosed, "Connection closed"));
    }
    this.pending.clear();
    this.onclose?.();
  }
}

/** Largest message accepted on stdin, like the MCP SDK's stdio transport. */
export const STDIO_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/** Newline-delimited JSON-RPC on a readable and a writable stream (stdin and stdout for `genigrep mcp`). */
export class StdioTransport implements McpTransport {
  private buffer: Buffer = Buffer.alloc(0);
  private started = false;
  onmessage?(message: JsonRpcMessage): void;
  onclose?(): void;
  onerror?(error: Error): void;

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  private readonly onData = (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, bytes]) : bytes;
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) break;
      const line = this.buffer.toString("utf8", 0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.onerror?.(new Error("received a line that is not JSON; ignored"));
        continue;
      }
      if (isObject(message)) this.onmessage?.(message);
    }
    if (this.buffer.length > STDIO_MAX_MESSAGE_BYTES) {
      this.buffer = Buffer.alloc(0);
      this.onerror?.(new Error(`message exceeds ${STDIO_MAX_MESSAGE_BYTES} bytes; dropped`));
    }
  };

  private readonly onInputError = (error: Error) => this.onerror?.(error);

  async start(): Promise<void> {
    if (this.started) throw new Error("StdioTransport already started");
    this.started = true;
    this.input.on("data", this.onData);
    this.input.on("error", this.onInputError);
  }

  send(message: JsonRpcMessage): Promise<void> {
    return new Promise((resolve) => {
      if (this.output.write(JSON.stringify(message) + "\n")) resolve();
      else this.output.once("drain", () => resolve());
    });
  }

  async close(): Promise<void> {
    this.input.off("data", this.onData);
    this.input.off("error", this.onInputError);
    if (this.input.listenerCount("data") === 0) this.input.pause();
    this.buffer = Buffer.alloc(0);
    this.onclose?.();
  }
}
