import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {fileURLToPath} from "node:url";
import {test} from "node:test";
import assert from "node:assert/strict";

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type ToolResult = {
  content: Array<{type: string; text: string}>;
  isError?: boolean;
};

const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: {
    name: "task1-test-client",
    version: "1.0.0",
  },
};

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

class TestClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly output: string[] = [];
  private buffer = "";
  private nextId = 1;
  private stderrBuffer = "";

  constructor(env: NodeJS.ProcessEnv = {}) {
    this.child = spawn(
      process.execPath,
      ["--import", "tsx", "src/index.ts"],
      {
        cwd: packageRoot,
        env: {...process.env, ...env},
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.readStdout(chunk);
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
    });

    this.child.on("exit", () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Server exited before responding"));
      }

      this.pending.clear();
    });
  }

  get lines(): string[] {
    return [...this.output];
  }

  get stderr(): string {
    return this.stderrBuffer;
  }

  request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload =
      params === undefined
        ? {jsonrpc: "2.0", id, method}
        : {jsonrpc: "2.0", id, method, params};

    return this.send(id, JSON.stringify(payload), method);
  }

  rawToolCall(name: string, rawArguments: string): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload =
      `{"jsonrpc":"2.0","id":${id},"method":"tools/call",` +
      `"params":{"name":${JSON.stringify(name)},"arguments":${rawArguments}}}`;

    return this.send(id, payload, `tools/call ${name}`);
  }

  notify(method: string, params?: unknown): void {
    const payload =
      params === undefined
        ? {jsonrpc: "2.0", method}
        : {jsonrpc: "2.0", method, params};

    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async waitForStderr(pattern: RegExp): Promise<void> {
    const deadline = Date.now() + 3000;

    while (Date.now() < deadline) {
      if (pattern.test(this.stderr)) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(
      "Timed out waiting for stderr to match " + String(pattern) + ". stderr: " + this.stderr
    );
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) {
      return;
    }

    this.child.stdin.end();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 3000);

      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private send(
    id: number,
    rawPayload: string,
    label: string
  ): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${label}`));
      }, 5000);

      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(`${rawPayload}\n`);
    });
  }

  private readStdout(chunk: string): void {
    this.buffer += chunk;

    let newline = this.buffer.indexOf("\n");

    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);

      if (line !== "") {
        this.handleLine(line);
      }

      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    this.output.push(line);

    const message = JSON.parse(line) as JsonRpcResponse;

    if (message.id === undefined || message.id === null) {
      return;
    }

    const entry = this.pending.get(Number(message.id));

    if (entry === undefined) {
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(Number(message.id));
    entry.resolve(message);
  }
}

function assertJsonRpcLines(client: TestClient): JsonRpcResponse[] {
  return client.lines.map((line) => {
    const message = JSON.parse(line) as JsonRpcResponse;

    assert.equal(message.jsonrpc, "2.0");
    assert.ok("result" in message || "error" in message);

    return message;
  });
}

async function initialize(client: TestClient): Promise<void> {
  const response = await client.request("initialize", INITIALIZE_PARAMS);

  assert.equal(response.error, undefined);
  assert.ok(response.result);

  client.notify("notifications/initialized");
}

function assertInvalidParams(response: JsonRpcResponse, field: RegExp): void {
  assert.equal(response.error?.code, -32602);
  assert.match(response.error?.message ?? "", field);
}

test("handles the protocol flow and rejects malformed tool calls", async () => {
  const client = new TestClient({LOG_LEVEL: "error"});

  try {
    await initialize(client);

    const list = await client.request("tools/list", {});
    const tools = (
      list.result as {
        tools: Array<{name: string; inputSchema: {type?: string}}>;
      }
    ).tools;

    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["get_customer_record", "trigger_refund"]
    );

    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
    }

    const refundResponse = await client.request("tools/call", {
      name: "trigger_refund",
      arguments: {
        customer_id: "CUST-12345",
        amount: 25.5,
        reason: "Duplicate payment",
      },
    });

    assert.equal(refundResponse.error, undefined);

    const refundResult = refundResponse.result as ToolResult;
    const refund = JSON.parse(refundResult.content[0]?.text ?? "{}") as {
      customer_id: string;
      amount: number;
      status: string;
    };

    assert.equal(refund.customer_id, "CUST-12345");
    assert.equal(refund.amount, 25.5);
    assert.equal(refund.status, "processed");

    const customerResponse = await client.request("tools/call", {
      name: "get_customer_record",
      arguments: {customer_id: "CUST-67890"},
    });

    assert.equal(customerResponse.error, undefined);

    const missingResponse = await client.request("tools/call", {
      name: "get_customer_record",
      arguments: {customer_id: "CUST-99999"},
    });

    assert.equal(missingResponse.error, undefined);
    assert.equal((missingResponse.result as ToolResult).isError, true);

    const badCustomerIds = [
      "cust-12345",
      "CUST-12345\n",
      "CUST-\u0661\u0662\u0663\u0664\u0665",
      "CUST-1234",
    ];

    for (const customerId of badCustomerIds) {
      const response = await client.request("tools/call", {
        name: "get_customer_record",
        arguments: {customer_id: customerId},
      });

      assertInvalidParams(response, /customer_id/);
    }

    const finiteFailure = await client.rawToolCall(
      "trigger_refund",
      '{"customer_id":"CUST-12345","amount":1e999,"reason":"Duplicate payment"}'
    );
    assertInvalidParams(finiteFailure, /amount/);

    const badRefundArguments: Array<{arguments: unknown; field: RegExp}> = [
      {
        arguments: {customer_id: "CUST-12345", amount: 0, reason: "Duplicate payment"},
        field: /amount/,
      },
      {
        arguments: {customer_id: "CUST-12345", amount: -100, reason: "Duplicate payment"},
        field: /amount/,
      },
      {
        arguments: {customer_id: "CUST-12345", amount: "10", reason: "Duplicate payment"},
        field: /amount/,
      },
      {
        arguments: {customer_id: "CUST-12345", amount: 1.005, reason: "Duplicate payment"},
        field: /amount/,
      },
      {
        arguments: {customer_id: "CUST-12345", amount: null, reason: "Duplicate payment"},
        field: /amount/,
      },
      {
        arguments: {customer_id: "CUST-12345", amount: 10001, reason: "Duplicate payment"},
        field: /amount/,
      },
      {
        arguments: {customer_id: "CUST-12345", amount: 25, reason: "Duplicate"},
        field: /reason/,
      },
      {
        arguments: {
          customer_id: "CUST-12345",
          amount: 25,
          reason: "a".repeat(501),
        },
        field: /reason/,
      },
      {
        arguments: {customer_id: "CUST-12345"},
        field: /amount/,
      },
      {
        arguments: {
          customer_id: "CUST-12345",
          amount: 25,
          reason: "Duplicate payment",
          currency: "USD",
        },
        field: /currency/,
      },
    ];

    for (const badCall of badRefundArguments) {
      const response = await client.request("tools/call", {
        name: "trigger_refund",
        arguments: badCall.arguments,
      });

      assertInvalidParams(response, badCall.field);
    }

    const unknownTool = await client.request("tools/call", {
      name: "delete_customer",
      arguments: {customer_id: "CUST-12345"},
    });

    assertInvalidParams(unknownTool, /delete_customer/);

    const messages = assertJsonRpcLines(client);
    assert.equal(messages.length, client.lines.length);
  } finally {
    await client.close();
  }
});

test("keeps debug logs off stdout", async () => {
  const client = new TestClient({LOG_LEVEL: "debug"});

  try {
    await initialize(client);
    await client.request("tools/list", {});
    await client.request("tools/call", {
      name: "get_customer_record",
      arguments: {customer_id: "CUST-12345"},
    });

    await client.waitForStderr(/DEBUG/);

    assert.match(client.stderr, /INFO Customer support MCP server running on stdio/);

    for (const line of client.lines) {
      const message = JSON.parse(line) as JsonRpcResponse;

      assert.equal(message.jsonrpc, "2.0");
      assert.ok("result" in message || "error" in message);
      assert.ok(!line.includes("DEBUG"));
      assert.ok(!line.includes("Customer support MCP server"));
    }
  } finally {
    await client.close();
  }
});