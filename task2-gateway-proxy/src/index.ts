import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { authenticate } from "./auth.js";
import {
  errorCodes,
  errorResponse,
  isNotification,
  isToolNameValid,
  parseJsonRpc,
  toolCallName,
  type JsonRpcId,
} from "./jsonrpc.js";
import {
  buildForwardHeaders,
  forwardRequest,
  pipeUpstreamResponse,
} from "./proxy.js";

const defaultPort = 3000;
const defaultDownstreamUrl = "http://localhost:4000/mcp";
const defaultTimeoutMs = 10_000;

export type GatewayOptions = {
  downstreamUrl: string;
  timeoutMs?: number;
};

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function createGatewayServer(options: GatewayOptions): Server {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

  return createServer(async (req, res) => {
    let requestId: JsonRpcId | null = null;
    let notification = false;

    try {
      if (req.method !== "POST") {
        sendJson(
          res,
          405,
          errorResponse(
            null,
            errorCodes.invalidRequest,
            "Method Not Allowed"
          )
        );
        return;
      }

      const role = authenticate(req.headers.authorization);

      if (role === null) {
        sendJson(
          res,
          401,
          errorResponse(null, errorCodes.unauthorizedToolCall, "Unauthorized")
        );
        return;
      }

      const body = await readRequestBody(req);
      const parsed = parseJsonRpc(body);

      if (!parsed.ok) {
        sendJson(res, parsed.status, parsed.response);
        return;
      }

      const request = parsed.request;
      requestId = request.id ?? null;
      notification = isNotification(request);

      if (request.method === "tools/call") {
        const name = toolCallName(request);

        if (name === null || !isToolNameValid(name)) {
          sendJson(
            res,
            200,
            errorResponse(
              requestId,
              errorCodes.invalidParams,
              "Invalid params"
            )
          );
          return;
        }

        if (name.toLowerCase().startsWith("admin_") && role !== "admin") {
          sendJson(
            res,
            200,
            errorResponse(
              requestId,
              errorCodes.unauthorizedToolCall,
              "Unauthorized Tool Call"
            )
          );
          return;
        }
      }

      const upstream = await forwardRequest({
        downstreamUrl: options.downstreamUrl,
        headers: buildForwardHeaders(req.headers),
        body,
        timeoutMs,
      });

      if (notification) {
        await upstream.body?.cancel();
        res.writeHead(202);
        res.end();
        return;
      }

      await pipeUpstreamResponse(upstream, res);
    } catch {
      if (notification) {
        res.writeHead(202);
        res.end();
        return;
      }

      if (res.headersSent) {
        res.destroy();
        return;
      }

      sendJson(
        res,
        502,
        errorResponse(
          requestId,
          errorCodes.upstreamError,
          "Upstream service error"
        )
      );
    }
  });
}

const entrypoint = process.argv[1];

if (
  entrypoint !== undefined &&
  pathToFileURL(entrypoint).href === import.meta.url
) {
  const port = Number(process.env.PORT ?? defaultPort);
  const downstreamUrl =
    process.env.DOWNSTREAM_URL ?? defaultDownstreamUrl;
  const timeoutMs = Number(
    process.env.DOWNSTREAM_TIMEOUT_MS ?? defaultTimeoutMs
  );

  const server = createGatewayServer({ downstreamUrl, timeoutMs });

  server.listen(port, () => {
    console.log(`Gateway proxy listening on port ${port}`);
  });
}