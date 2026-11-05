import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

import { normalizeRole } from "../src/auth.js";
import { createGatewayServer } from "../src/index.js";
import {
  createMockDownstream,
  type MockState,
} from "../src/mock-server.js";

type ErrorBody = {
  jsonrpc: string;
  id: unknown;
  error: { code: number; message: string };
};

type ResultBody = {
  jsonrpc: string;
  id: unknown;
  result: Record<string, unknown>;
};

let mockServer: Server;
let gatewayServer: Server;
let gatewayUrl: string;
let state: MockState;

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
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

type RequestOptions = {
  authorization?: string;
  headers?: Record<string, string>;
  method?: string;
  rawBody?: string;
};

async function gatewayRequest(
  body: unknown,
  options: RequestOptions = {}
): Promise<Response> {
  const method = options.method ?? "POST";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.headers,
  };

  if (options.authorization !== undefined) {
    headers.authorization = options.authorization;
  }

  const init: RequestInit = { method, headers };

  if (method === "POST") {
    init.body = options.rawBody ?? JSON.stringify(body);
  }

  return fetch(gatewayUrl, init);
}

before(async () => {
  const mock = createMockDownstream();
  mockServer = mock.server;
  state = mock.state;

  const downstreamPort = await listen(mockServer);
  const downstreamUrl = `http://127.0.0.1:${downstreamPort}/mcp`;

  gatewayServer = createGatewayServer({
    downstreamUrl,
    timeoutMs: 1_000,
  });

  const gatewayPort = await listen(gatewayServer);
  gatewayUrl = `http://127.0.0.1:${gatewayPort}/mcp`;
});

after(async () => {
  await Promise.all([close(gatewayServer), close(mockServer)]);
});

beforeEach(() => {
  state.hits = 0;
  state.headers = {};
  state.body = "";
});

test("invalid JSON returns -32700", async () => {
  const response = await gatewayRequest(null, {
    authorization: "Bearer viewer-secret",
    rawBody: "{",
  });

  assert.equal(response.status, 400);

  const body = (await response.json()) as ErrorBody;
  assert.equal(body.error.code, -32700);
  assert.equal(state.hits, 0);
});

test("non-object, wrong version, and non-string method return -32600", async () => {
  const rawResponses = ["\"text\"", "[]"];

  for (const rawBody of rawResponses) {
    const response = await gatewayRequest(null, {
      authorization: "Bearer viewer-secret",
      rawBody,
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as ErrorBody;
    assert.equal(body.error.code, -32600);
  }

  for (const body of [
    { jsonrpc: "1.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 1, method: 42 },
  ]) {
    const response = await gatewayRequest(body, {
      authorization: "Bearer viewer-secret",
    });

    assert.equal(response.status, 400);
    const parsed = (await response.json()) as ErrorBody;
    assert.equal(parsed.error.code, -32600);
  }

  assert.equal(state.hits, 0);
});

test("viewer batch containing an admin call is rejected before forwarding", async () => {
  const response = await gatewayRequest(
    [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "admin_reset_key" },
      },
    ],
    { authorization: "Bearer viewer-secret" }
  );

  assert.equal(response.status, 400);

  const body = (await response.json()) as ErrorBody;
  assert.equal(body.error.code, -32600);
  assert.equal(state.hits, 0);
});

test("viewer admin tool call is denied with id preserved", async () => {
  const response = await gatewayRequest(
    {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "admin_reset_key" },
    },
    { authorization: "Bearer viewer-secret" }
  );

  assert.equal(response.status, 200);

  const body = (await response.json()) as ErrorBody;
  assert.equal(body.id, 42);
  assert.equal(body.error.code, -32001);
  assert.equal(body.error.message, "Unauthorized Tool Call");
  assert.equal(state.hits, 0);
});

test("admin detection is case-insensitive", async () => {
  const response = await gatewayRequest(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "Admin_Reset_Key" },
    },
    { authorization: "Bearer viewer-secret" }
  );

  assert.equal(response.status, 200);

  const body = (await response.json()) as ErrorBody;
  assert.equal(body.id, 7);
  assert.equal(body.error.code, -32001);
  assert.equal(state.hits, 0);
});

test("admin tool call is forwarded and succeeds", async () => {
  const response = await gatewayRequest(
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "admin_reset_key" },
    },
    { authorization: "Bearer admin-secret" }
  );

  assert.equal(response.status, 200);

  const body = (await response.json()) as ResultBody;
  assert.equal(body.id, 11);
  assert.equal(body.result.message, "Mock downstream success");
  assert.equal(state.hits, 1);
});

test("tool names with whitespace return -32602 without forwarding", async () => {
  const response = await gatewayRequest(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "admin reset_key" },
    },
    { authorization: "Bearer viewer-secret" }
  );

  assert.equal(response.status, 200);

  const body = (await response.json()) as ErrorBody;
  assert.equal(body.id, 5);
  assert.equal(body.error.code, -32602);
  assert.equal(state.hits, 0);
});

test("missing and malformed tokens return 401", async () => {
  const authorizations = [
    undefined,
    "Bearer",
    "Bearer ",
    "bearer viewer-secret",
    "Bearer  viewer-secret",
    "Bearer viewer-secret extra",
    "Basic viewer-secret",
    "Bearer unknown-token",
  ];

  for (const authorization of authorizations) {
    const response = await gatewayRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      authorization === undefined ? {} : { authorization }
    );

    assert.equal(response.status, 401);

    const body = (await response.json()) as ErrorBody;
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(typeof body.error.code, "number");
  }

  assert.equal(state.hits, 0);
});

test("unknown roles are treated as viewer", () => {
  assert.equal(normalizeRole("admin"), "admin");
  assert.equal(normalizeRole("viewer"), "viewer");
  assert.equal(normalizeRole("superuser"), "viewer");
  assert.equal(normalizeRole(undefined), null);
});

test("downstream headers are forwarded without Authorization", async () => {
  const requestHeaders = {
    accept: "application/json",
    "mcp-session-id": "session-123",
    "mcp-protocol-version": "2025-06-18",
  };

  const response = await gatewayRequest(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    },
    {
      authorization: "Bearer viewer-secret",
      headers: requestHeaders,
    }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-mock-downstream"), "true");

  const body = (await response.json()) as ResultBody;
  const echoed = body.result.headers as Record<string, unknown>;

  for (const name of [
    "content-type",
    "accept",
    "mcp-session-id",
    "mcp-protocol-version",
  ]) {
    assert.ok(name in echoed, `expected downstream to receive ${name}`);
  }

  const receivedNames = Object.keys(echoed).map((name) => name.toLowerCase());
  assert.equal(receivedNames.includes("authorization"), false);

  const stateNames = Object.keys(state.headers).map((name) =>
    name.toLowerCase()
  );
  assert.equal(stateNames.includes("authorization"), false);
});

test("notifications are forwarded and return no JSON-RPC body", async () => {
  const response = await gatewayRequest(
    { jsonrpc: "2.0", method: "tools/list" },
    { authorization: "Bearer viewer-secret" }
  );

  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
  assert.equal(state.hits, 1);
});

test("tools/list is forwarded unchanged", async () => {
  const request = {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/list",
    params: {},
  };
  const expectedBody = JSON.stringify(request);

  const response = await gatewayRequest(request, {
    authorization: "Bearer viewer-secret",
  });

  assert.equal(response.status, 200);
  assert.equal(state.body, expectedBody);
});

test("non-POST methods return 405", async () => {
  const response = await gatewayRequest(null, {
    method: "GET",
  });

  assert.equal(response.status, 405);

  const body = (await response.json()) as ErrorBody;
  assert.equal(body.error.code, -32600);
  assert.equal(state.hits, 0);
});

test("downstream outage returns a sanitized -32603", async () => {
  const outageServer = createGatewayServer({
    downstreamUrl: "http://127.0.0.1:1/mcp",
    timeoutMs: 500,
  });
  const outagePort = await listen(outageServer);
  const outageUrl = `http://127.0.0.1:${outagePort}/mcp`;

  try {
    const response = await fetch(outageUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer viewer-secret",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 13,
        method: "tools/list",
      }),
    });

    assert.equal(response.status, 502);

    const body = (await response.json()) as ErrorBody;
    assert.equal(body.id, 13);
    assert.equal(body.error.code, -32603);

    const serialized = JSON.stringify(body).toLowerCase();
    assert.equal(serialized.includes("econnrefused"), false);
    assert.equal(serialized.includes("127.0.0.1"), false);
    assert.equal(serialized.includes("stack"), false);
  } finally {
    await close(outageServer);
  }
});