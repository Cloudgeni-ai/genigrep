#!/usr/bin/env node
/** Process entry point: wires main() to the real terminal, stdin, signals and exit code. */
import { EXIT } from "./cli/args";
import { InterruptedError, main } from "./cli/main";

/** Read the key: a no-echo prompt on a terminal, otherwise the first line of stdin. */
async function readSecret(prompt: string): Promise<string | null> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer));
    const line = Buffer.concat(chunks).toString("utf8").split(/\r?\n/).find((l) => l.trim());
    return line?.trim() ?? null;
  }
  process.stderr.write(prompt);
  return await new Promise<string | null>((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value || null);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") return done(new InterruptedError("interrupted"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

function writer(stream: NodeJS.WriteStream): (text: string) => void {
  return (text) => {
    if (text) stream.write(text);
  };
}

// A closed pipe (genigrep ... | head) is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(EXIT.OK);
    throw error;
  });
}

const controller = new AbortController();
let interrupts = 0;
process.on("SIGINT", () => {
  interrupts++;
  if (interrupts > 1) process.exit(EXIT.INTERRUPTED);
  controller.abort(new InterruptedError("interrupted"));
});

main(process.argv.slice(2), {
  stdout: writer(process.stdout),
  stderr: writer(process.stderr),
  env: process.env,
  cwd: process.cwd(),
  signal: controller.signal,
  readSecret,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`genigrep: unexpected error: ${message}\n`);
    process.exitCode = EXIT.FAILED;
  });
