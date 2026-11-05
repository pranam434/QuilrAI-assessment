import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createChatServer } from "../src/index.js";
import {
  createMockUpstream,
  type MockUpstream,
  type MockUpstreamOptions,
} from "../src/mock-upstream.js";

const done = "data: [DONE]\n\n";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function contentChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

function finishChunk(reason = "stop"): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  })}\n\n`;
}

type OutputEvent =
  | { kind: "json"; json: Record<string, unknown> }
  | { kind: "done" }
  | { kind: "raw"; text: string };

async function readStream(
  url: string
): Promise<{ text: string; events: OutputEvent[] }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream: true }),
  });
  const text = await response.text();
  const events: OutputEvent[] = [];

  for (const block of text.split("\n\n")) {
    if (block === "") {
      continue;
    }

    const dataLine = block
      .split("\n")
      .find((line) => line.startsWith("data:"));

    if (dataLine === undefined) {
      events.push({ kind: "raw", text: block });
      continue;
    }

    const data = dataLine.slice(5).trim();

    if (data === "[DONE]") {
      events.push({ kind: "done" });
      continue;
    }

    try {
      events.push({
        kind: "json",
        json: JSON.parse(data) as Record<string, unknown>,
      });
    } catch {
      events.push({ kind: "raw", text: block });
    }
  }

  return { text, events };
}

function contentOf(events: OutputEvent[]): string {
  let content = "";

  for (const event of events) {
    if (event.kind !== "json") {
      continue;
    }

    const choices = event.json.choices as
      | Array<{ delta?: { content?: unknown } }>
      | undefined;
    const delta = choices?.[0]?.delta?.content;

    if (typeof delta === "string") {
      content += delta;
    }
  }

  return content;
}

async function withGateway(
  options: MockUpstreamOptions,
  run: (gatewayUrl: string, mock: MockUpstream) => Promise<void>
): Promise<void> {
  const mock = createMockUpstream(options);
  const mockPort = await listen(mock.server);
  const upstreamUrl = `http://127.0.0.1:${mockPort}/v1/chat/completions`;
  const gateway = createChatServer({ upstreamUrl });
  const gatewayPort = await listen(gateway);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;

  try {
    await run(gatewayUrl, mock);
  } finally {
    await Promise.all([close(gateway), close(mock.server)]);
  }
}

test("redacts email, ssn, and luhn card while preserving the rest", async () => {
  const text =
    "my email is alice@example.com and ssn 123-45-6789 and " +
    "card 4242 4242 4242 4242 with 1234567890123456 on 2024-01-15 and 42.";

  await withGateway({ text }, async (gatewayUrl) => {
    const { events } = await readStream(gatewayUrl);

    assert.equal(
      contentOf(events),
      "my email is [EMAIL] and ssn [SSN] and card [CARD] with " +
        "1234567890123456 on 2024-01-15 and 42."
    );
  });
});

test("flushes held tail on [DONE]", async () => {
  await withGateway(
    { events: [contentChunk("email alice@example.com"), done] },
    async (gatewayUrl) => {
      const { events } = await readStream(gatewayUrl);

      assert.equal(contentOf(events), "email [EMAIL]");
      assert.equal(events.at(-1)?.kind, "done");
    }
  );
});

test("emits held tail before the finish event", async () => {
  await withGateway(
    {
      events: [
        contentChunk("contact alice@example.com"),
        finishChunk(),
        done,
      ],
    },
    async (gatewayUrl) => {
      const { events } = await readStream(gatewayUrl);
      const finishIndex = events.findIndex(
        (event) =>
          event.kind === "json" &&
          Array.isArray(event.json.choices) &&
          (event.json.choices as Array<{ finish_reason?: unknown }>)[0]
            ?.finish_reason === "stop"
      );
      const contentBefore = events
        .slice(0, finishIndex)
        .reduce<string>((sum, event) => sum + contentAt(event), "");

      assert.equal(contentBefore, "contact [EMAIL]");
      assert.ok(finishIndex >= 0);
    }
  );
});

function contentAt(event: OutputEvent): string {
  if (event.kind !== "json") {
    return "";
  }

  const choices = event.json.choices as
    | Array<{ delta?: { content?: unknown } }>
    | undefined;
  const content = choices?.[0]?.delta?.content;

  return typeof content === "string" ? content : "";
}

test("drops invalid JSON and logs to stderr", async () => {
  const captured: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await withGateway(
      {
        events: [
          contentChunk("before "),
          "data: {not json}\n\n",
          contentChunk("after"),
          done,
        ],
      },
      async (gatewayUrl) => {
        const { events } = await readStream(gatewayUrl);

        assert.equal(contentOf(events), "before after");
      }
    );
  } finally {
    process.stderr.write = original;
  }

  assert.ok(captured.join("").includes("invalid JSON"));
});

test("processes CRLF framed events", async () => {
  await withGateway(
    {
      events: [
        contentChunk("card 4242 4242 4242 4242 done").replace(/\n/g, "\r\n"),
        done.replace(/\n/g, "\r\n"),
      ],
    },
    async (gatewayUrl) => {
      const { events } = await readStream(gatewayUrl);

      assert.equal(contentOf(events), "card [CARD] done");
    }
  );
});

test("flushes a final event with no trailing blank line", async () => {
  const withoutBlank = contentChunk("ssn 123-45-6789").slice(0, -2);

  await withGateway({ events: [withoutBlank] }, async (gatewayUrl) => {
    const { events } = await readStream(gatewayUrl);

    assert.equal(contentOf(events), "ssn [SSN]");
  });
});

test("aborts upstream when the client disconnects", async () => {
  const events = Array.from({ length: 40 }, (_, index) =>
    contentChunk(`token-${index} `)
  );
  events.push(finishChunk(), done);

  await withGateway({ events, delayMs: 25 }, async (gatewayUrl, mock) => {
    await new Promise<void>((resolve, reject) => {
      const request = http.request(
        gatewayUrl,
        { method: "POST", headers: { "content-type": "application/json" } },
        (response) => {
          response.once("data", () => {
            response.destroy();
            request.destroy();
            resolve();
          });
        }
      );

      request.on("error", reject);
      request.write(JSON.stringify({ stream: true }));
      request.end();
    });

    const deadline = Date.now() + 3000;

    while (mock.state.aborts === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.ok(mock.state.aborts > 0, "upstream was not aborted");
  });
});

test("streams 50 MB to a slow client with flat RSS", async () => {
  const totalBytes = 50 * 1024 * 1024;

  await withGateway({ totalBytes }, async (gatewayUrl) => {
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 50);

    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true }),
    });
    const reader = response.body?.getReader();
    assert.ok(reader !== undefined, "no response body");

    await new Promise((resolve) => setTimeout(resolve, 300));

    let received = 0;
    let seen = 0;

    for (;;) {
      const { done: streamDone, value } = await reader.read();

      if (streamDone) {
        break;
      }

      received += value?.length ?? 0;
      seen += 1;

      if (seen % 64 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    clearInterval(sampler);

    assert.ok(received > totalBytes * 0.9, `only received ${received} bytes`);
    assert.ok(
      peak - baseline < 120 * 1024 * 1024,
      `RSS grew by ${Math.round((peak - baseline) / 1024 / 1024)} MB`
    );
  });
});
