import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { Redactor } from "./redactor.js";
import { SseParser, type SseEvent } from "./sse-parser.js";

const chatCompletionsPath = "/v1/chat/completions";

export type StreamTimings = {
  firstByteMs: number | null;
  firstUpstreamDeltaMs: number | null;
  firstClientDeltaMs: number | null;
};

export type ChatServerOptions = {
  upstreamUrl: string;
  onTiming?: (timings: StreamTimings) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logTimings(timings: StreamTimings): void {
  process.stderr.write(
    `[timing] first_byte=${timings.firstByteMs ?? "-"}ms ` +
      `first_upstream_delta=${timings.firstUpstreamDeltaMs ?? "-"}ms ` +
      `first_client_delta=${timings.firstClientDeltaMs ?? "-"}ms\n`
  );
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

function buildUpstreamHeaders(incoming: IncomingMessage["headers"]): Headers {
  const headers = new Headers();

  for (const name of ["content-type", "accept", "authorization"] as const) {
    const value = incoming[name];

    if (typeof value === "string") {
      headers.set(name, value);
    }
  }

  return headers;
}

class RedactingSseTransform extends Transform {
  private readonly parser = new SseParser();
  private readonly decoder = new StringDecoder("utf8");
  private readonly redactors = new Map<number, Redactor>();
  private readonly startedAt: number;
  private readonly onTiming: (timings: StreamTimings) => void;
  private readonly timings: StreamTimings = {
    firstByteMs: null,
    firstUpstreamDeltaMs: null,
    firstClientDeltaMs: null,
  };
  private template: Record<string, unknown> | null = null;

  constructor(startedAt: number, onTiming: (timings: StreamTimings) => void) {
    super();
    this.startedAt = startedAt;
    this.onTiming = onTiming;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    try {
      if (this.timings.firstByteMs === null) {
        this.timings.firstByteMs = Date.now() - this.startedAt;
      }

      for (const event of this.parser.push(this.decoder.write(chunk))) {
        this.handleEvent(event);
      }

      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      for (const event of this.parser.flush()) {
        this.handleEvent(event);
      }

      this.flushAllRedactors();
      this.onTiming(this.timings);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private pushText(text: string): void {
    if (text.length === 0) {
      return;
    }

    if (this.timings.firstClientDeltaMs === null) {
      this.timings.firstClientDeltaMs = Date.now() - this.startedAt;
    }

    this.push(text);
  }

  private handleEvent(event: SseEvent): void {
    if (event.data === null) {
      this.pushText(event.raw);
      return;
    }

    if (event.data.trim() === "[DONE]") {
      this.flushAllRedactors();
      this.pushText(event.raw);
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(event.data);
    } catch {
      process.stderr.write("[pii-stream] dropping event with invalid JSON\n");
      return;
    }

    if (!isRecord(parsed)) {
      this.pushText(event.raw);
      return;
    }

    const choices = parsed.choices;

    if (!Array.isArray(choices) || choices.length === 0) {
      this.pushText(event.raw);
      return;
    }

    if (this.timings.firstUpstreamDeltaMs === null) {
      this.timings.firstUpstreamDeltaMs = Date.now() - this.startedAt;
    }

    this.template = parsed;
    this.redactEvent(event, parsed, choices);
  }

  private redactEvent(
    event: SseEvent,
    parsed: Record<string, unknown>,
    choices: unknown[]
  ): void {
    const contentChoices: unknown[] = [];
    const passthroughChoices: unknown[] = [];
    const finishChoices: unknown[] = [];
    const tailChunks: string[] = [];

    for (const choice of choices) {
      if (!isRecord(choice)) {
        passthroughChoices.push(choice);
        continue;
      }

      const index = choice.index;
      const delta = choice.delta;
      const hasContent = isRecord(delta) && typeof delta.content === "string";
      const isFinish =
        choice.finish_reason !== null && choice.finish_reason !== undefined;

      if (hasContent && typeof index === "number") {
        const head = this.getRedactor(index).push(delta.content as string);

        if (head !== "") {
          contentChoices.push({
            ...choice,
            finish_reason: null,
            delta: { ...delta, content: head },
          });
        }
      } else if (!isFinish) {
        passthroughChoices.push(choice);
      }

      if (isFinish && typeof index === "number") {
        const tail = this.getRedactor(index).flush();

        if (tail !== "") {
          tailChunks.push(this.makeChunk(index, tail));
        }

        finishChoices.push(
          isRecord(delta)
            ? { ...choice, delta: { ...delta, content: "" } }
            : choice
        );
      }
    }

    const bodyChoices = [...passthroughChoices, ...contentChoices];

    if (bodyChoices.length > 0) {
      this.pushText(
        this.serialize(event, { ...parsed, choices: bodyChoices })
      );
    }

    for (const chunk of tailChunks) {
      this.pushText(chunk);
    }

    if (finishChoices.length > 0) {
      this.pushText(
        this.serialize(event, { ...parsed, choices: finishChoices })
      );
    }
  }

  private serialize(event: SseEvent, payload: unknown): string {
    let output = "";

    for (const comment of event.comments) {
      output += `${comment}\n`;
    }

    for (const field of event.fields) {
      output += `${field.name}: ${field.value}\n`;
    }

    return `${output}data: ${JSON.stringify(payload)}\n\n`;
  }

  private makeChunk(index: number, content: string): string {
    const template = this.template ?? {};
    const payload = {
      ...template,
      choices: [{ index, delta: { content }, finish_reason: null }],
    };

    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  private getRedactor(index: number): Redactor {
    const existing = this.redactors.get(index);

    if (existing !== undefined) {
      return existing;
    }

    const redactor = new Redactor();
    this.redactors.set(index, redactor);

    return redactor;
  }

  private flushAllRedactors(): void {
    for (const [index, redactor] of this.redactors) {
      const tail = redactor.flush();

      if (tail !== "") {
        this.pushText(this.makeChunk(index, tail));
      }
    }
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

export function createChatServer(options: ChatServerOptions): Server {
  const onTiming = options.onTiming ?? logTimings;

  return createServer(async (req, res) => {
    const startedAt = Date.now();
    const path = (req.url ?? "").split("?")[0];

    if (req.method !== "POST" || path !== chatCompletionsPath) {
      sendJson(res, 404, { error: { message: "Not found" } });
      return;
    }

    const body = await readRequestBody(req);
    const controller = new AbortController();
    const abortUpstream = () => controller.abort();

    res.on("close", abortUpstream);

    let upstream: Response;

    try {
      upstream = await fetch(options.upstreamUrl, {
        method: "POST",
        headers: buildUpstreamHeaders(req.headers),
        body,
        signal: controller.signal,
      });
    } catch {
      if (res.headersSent) {
        res.destroy();
      } else {
        sendJson(res, 502, { error: { message: "Upstream unreachable" } });
      }

      res.off("close", abortUpstream);
      return;
    }

    if (!upstream.ok || upstream.body === null) {
      const detail = await upstream.text().catch(() => "");

      if (!res.headersSent) {
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(
          detail === ""
            ? JSON.stringify({ error: { message: "Upstream error" } })
            : detail
        );
      } else {
        res.destroy();
      }

      res.off("close", abortUpstream);
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();

    const transform = new RedactingSseTransform(startedAt, onTiming);

    try {
      await pipeline(
        Readable.fromWeb(
          upstream.body as import("node:stream/web").ReadableStream<Uint8Array>
        ),
        transform,
        res
      );
    } catch {
      res.destroy();
    } finally {
      res.off("close", abortUpstream);
      controller.abort();
    }
  });
}

const entrypoint = process.argv[1];

if (
  entrypoint !== undefined &&
  pathToFileURL(entrypoint).href === import.meta.url
) {
  const port = Number(process.env.PORT ?? 3010);
  const upstreamUrl =
    process.env.UPSTREAM_URL ?? "http://localhost:4010/v1/chat/completions";

  const server = createChatServer({ upstreamUrl });

  server.listen(port, () => {
    console.log(`PII stream gateway listening on port ${port}`);
  });
}
