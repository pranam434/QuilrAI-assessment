import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const forwardedHeaders = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
] as const;

const excludedResponseHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

export function buildForwardHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();

  for (const name of forwardedHeaders) {
    const value = incoming[name];

    if (typeof value === "string") {
      headers.set(name, value);
    }
  }

  return headers;
}

export type ForwardOptions = {
  downstreamUrl: string;
  headers: Headers;
  body: string;
  timeoutMs: number;
};

export async function forwardRequest(options: ForwardOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    return await fetch(options.downstreamUrl, {
      method: "POST",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function pipeUpstreamResponse(
  upstream: Response,
  res: ServerResponse
): Promise<void> {
  res.statusCode = upstream.status;

  for (const [name, value] of upstream.headers) {
    if (!excludedResponseHeaders.has(name.toLowerCase())) {
      res.setHeader(name, value);
    }
  }

  const setCookie = upstream.headers.getSetCookie();

  if (setCookie.length > 0) {
    res.setHeader("set-cookie", setCookie);
  }

  if (upstream.body === null) {
    res.end();
    return;
  }

  await pipeline(
    Readable.fromWeb(
      upstream.body as import("node:stream/web").ReadableStream<Uint8Array>
    ),
    res
  );
}