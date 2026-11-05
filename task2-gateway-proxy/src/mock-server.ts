import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { pathToFileURL } from "node:url";

export type MockState = {
  hits: number;
  headers: IncomingHttpHeaders;
  body: string;
};

export type MockDownstream = {
  server: Server;
  state: MockState;
};

export function createMockDownstream(): MockDownstream {
  const state: MockState = {
    hits: 0,
    headers: {},
    body: "",
  };

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/__stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }

    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    const body = Buffer.concat(chunks).toString("utf-8");

    state.hits += 1;
    state.headers = req.headers;
    state.body = body;

    let request: unknown;

    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    if (
      typeof request !== "object" ||
      request === null ||
      Array.isArray(request)
    ) {
      res.writeHead(400);
      res.end();
      return;
    }

    const record = request as Record<string, unknown>;

    if (!("id" in record)) {
      res.writeHead(202);
      res.end();
      return;
    }

    const result =
      record.method === "tools/list"
        ? {
            tools: [
              { name: "get_customer_record" },
              { name: "admin_delete_customer" },
            ],
            headers: req.headers,
            hits: state.hits,
          }
        : {
            message: "Mock downstream success",
            headers: req.headers,
            hits: state.hits,
          };

    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Mock-Downstream": "true",
    });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: record.id,
        result,
      })
    );
  });

  return { server, state };
}

const entrypoint = process.argv[1];

if (
  entrypoint !== undefined &&
  pathToFileURL(entrypoint).href === import.meta.url
) {
  const port = Number(process.env.MOCK_PORT ?? 4000);
  const { server } = createMockDownstream();

  server.listen(port, () => {
    console.log(`Mock downstream listening on port ${port}`);
  });
}