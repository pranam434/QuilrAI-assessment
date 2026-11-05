import type { Server } from "node:http";
import { createChatServer } from "./src/index.js";
import { createMockUpstream } from "./src/mock-upstream.js";
import type { StreamTimings } from "./src/index.js";

const runs = Number(process.env.BENCH_RUNS ?? 20);
const body = JSON.stringify({
  model: "mock-model",
  stream: true,
  messages: [{ role: "user", content: "Say hi" }],
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        reject(new Error("Server did not bind to a TCP port"));
        return;
      }

      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readToEnd(url: string): Promise<number> {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstDeltaMs = -1;

  if (reader === undefined) {
    throw new Error("Upstream returned no body");
  }

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value ?? new Uint8Array(), { stream: true });

    if (firstDeltaMs === -1) {
      firstDeltaMs = findFirstDeltaMs(buffer, startedAt);
    }
  }

  return firstDeltaMs;
}

function findFirstDeltaMs(buffer: string, startedAt: number): number {
  for (const block of buffer.split("\n\n")) {
    const line = block.split("\n").find((entry) => entry.startsWith("data:"));

    if (line === undefined) {
      continue;
    }

    const data = line.slice(5).trim();

    if (data === "[DONE]" || data === "") {
      continue;
    }

    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: unknown } }>;
      };
      const content = parsed.choices?.[0]?.delta?.content;

      if (typeof content === "string" && content.length > 0) {
        return Date.now() - startedAt;
      }
    } catch {
      continue;
    }
  }

  return -1;
}

type ParseableTimings = StreamTimings;

function parseTiming(line: string): ParseableTimings {
  const match = /first_byte=(\d+|-)ms first_upstream_delta=(\d+|-)ms first_client_delta=(\d+|-)ms/.exec(
    line
  );
  const toNumber = (value: string | undefined): number | null =>
    value === undefined || value === "-" ? null : Number(value);

  return {
    firstByteMs: toNumber(match?.[1]),
    firstUpstreamDeltaMs: toNumber(match?.[2]),
    firstClientDeltaMs: toNumber(match?.[3]),
  };
}

async function runGateway(gatewayUrl: string): Promise<{
  firstDeltaMs: number;
  timings: ParseableTimings | null;
}> {
  const captured: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const firstDeltaMs = await readToEnd(gatewayUrl);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const line = captured.find((entry) => entry.includes("[timing]"));
    return { firstDeltaMs, timings: line ? parseTiming(line) : null };
  } finally {
    process.stderr.write = original;
  }
}

function average(values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

async function main(): Promise<void> {
  const mock = createMockUpstream({ text: defaultBenchText() });
  const mockPort = await listen(mock.server);
  const upstreamUrl = `http://127.0.0.1:${mockPort}/v1/chat/completions`;

  const gateway = createChatServer({ upstreamUrl });
  const gatewayPort = await listen(gateway);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;

  try {
    await runGateway(gatewayUrl);

    const direct: number[] = [];
    const through: number[] = [];
    const upstreamDeltas: number[] = [];
    const clientDeltas: number[] = [];
    const firstBytes: number[] = [];

    for (let index = 0; index < runs; index += 1) {
      direct.push(await readToEnd(upstreamUrl));

      const gatewayRun = await runGateway(gatewayUrl);
      through.push(gatewayRun.firstDeltaMs);
      const timings = gatewayRun.timings;

      if (timings !== null) {
        if (timings.firstByteMs !== null) {
          firstBytes.push(timings.firstByteMs);
        }

        if (timings.firstUpstreamDeltaMs !== null) {
          upstreamDeltas.push(timings.firstUpstreamDeltaMs);
        }

        if (timings.firstClientDeltaMs !== null) {
          clientDeltas.push(timings.firstClientDeltaMs);
        }
      }
    }

    process.stdout.write(
      [
        `runs: ${runs}`,
        `direct first delta:            ${average(direct).toFixed(2)} ms`,
        `gateway first delta (client):  ${average(through).toFixed(2)} ms`,
        `  first upstream byte:         ${average(firstBytes).toFixed(2)} ms`,
        `  first upstream delta:        ${average(upstreamDeltas).toFixed(2)} ms`,
        `  first client delta:          ${average(clientDeltas).toFixed(2)} ms`,
        "",
      ].join("\n")
    );
  } finally {
    await Promise.all([close(gateway), close(mock.server)]);
  }
}

export function defaultBenchText(): string {
  return "Here is a long assistant response with an email a@b.co, an SSN 123-45-6789, a card 4242 4242 4242 4242 and plenty of ordinary words to keep the stream going.";
}

main().catch((error: unknown) => {
  process.stderr.write(`bench failed: ${String(error)}\n`);
  process.exitCode = 1;
});
