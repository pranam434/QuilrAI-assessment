import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";

const defaultText =
  "The customer email is jane.doe@example.com and the SSN is 123-45-6789. " +
  "Card 4242 4242 4242 4242 is valid, but 1234567890123456 is not. " +
  "The date is 2024-01-15 and the count is 42.";

export type MockUpstreamOptions = {
  events?: string[];
  text?: string;
  model?: string;
  delayMs?: number;
  chunkSize?: number;
  initialDelayMs?: number;
  totalBytes?: number;
};

export type MockRequest = {
  method: string;
  url: string;
  body: string;
};

export type MockUpstream = {
  server: Server;
  state: {
    requests: MockRequest[];
    aborts: number;
  };
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentEvent(model: string, content: string): string {
  return (
    `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`
  );
}

function buildEvents(text: string, model: string): string[] {
  const events: string[] = [];
  const tokens = text.match(/\S+\s*/g) ?? [];

  events.push(
    `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`
  );

  for (const token of tokens) {
    events.push(contentEvent(model, token));
  }

  events.push(
    `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`
  );
  events.push("data: [DONE]\n\n");

  return events;
}

function splitString(value: string, size: number): string[] {
  if (size <= 0) {
    return [value];
  }

  const pieces: string[] = [];

  for (let index = 0; index < value.length; index += size) {
    pieces.push(value.slice(index, index + size));
  }

  return pieces;
}

async function writeChunk(
  res: ServerResponse,
  chunk: string
): Promise<boolean> {
  if (res.write(chunk)) {
    return true;
  }

  await once(res, "drain");
  return !res.destroyed;
}

async function streamBytes(
  res: ServerResponse,
  totalBytes: number,
  model: string,
  delayMs: number
): Promise<void> {
  await writeChunk(
    res,
    `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`
  );

  const piece = "The quick brown fox jumps over the lazy dog. ".repeat(96);
  const event = contentEvent(model, piece);
  let sent = 0;

  while (sent < totalBytes && !res.destroyed) {
    const ok = await writeChunk(res, event);

    if (!ok) {
      return;
    }

    sent += piece.length;

    if (delayMs > 0) {
      await wait(delayMs);
    }
  }

  if (res.destroyed) {
    return;
  }

  await writeChunk(
    res,
    `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`
  );
  await writeChunk(res, "data: [DONE]\n\n");
  res.end();
}

export function createMockUpstream(
  options: MockUpstreamOptions = {}
): MockUpstream {
  const model = options.model ?? "mock-model";
  const events = options.events ?? buildEvents(options.text ?? defaultText, model);
  const delayMs = options.delayMs ?? 0;
  const chunkSize = options.chunkSize ?? 0;
  const initialDelayMs = options.initialDelayMs ?? 0;
  const totalBytes = options.totalBytes ?? 0;

  const state: MockUpstream["state"] = { requests: [], aborts: 0 };

  const server = createServer(async (req: IncomingMessage, res) => {
    let body = "";

    for await (const chunk of req) {
      body += chunk.toString();
    }

    state.requests.push({ method: req.method ?? "", url: req.url ?? "", body });

    if (options.totalBytes === undefined) {
      const path = (req.url ?? "").split("?")[0];

      if (req.method !== "POST" || path !== "/v1/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Not found" } }));
        return;
      }
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    res.on("close", () => {
      if (!res.writableEnded) {
        state.aborts += 1;
      }
    });

    if (initialDelayMs > 0) {
      await wait(initialDelayMs);
    }

    if (totalBytes > 0) {
      await streamBytes(res, totalBytes, model, delayMs);
      return;
    }

    for (const event of events) {
      for (const piece of splitString(event, chunkSize)) {
        const ok = await writeChunk(res, piece);

        if (!ok) {
          return;
        }

        if (delayMs > 0) {
          await wait(delayMs);
        }
      }
    }

    res.end();
  });

  return { server, state };
}

const entrypoint = process.argv[1];

if (
  entrypoint !== undefined &&
  pathToFileURL(entrypoint).href === import.meta.url
) {
  const port = Number(process.env.MOCK_PORT ?? 4010);
  const { server } = createMockUpstream();

  server.listen(port, () => {
    console.log(`Mock upstream listening on port ${port}`);
  });
}
