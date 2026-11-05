# Task 1: Customer Support MCP Server

A runnable Model Context Protocol server built on the official
`@modelcontextprotocol/sdk` low-level `Server` and `StdioServerTransport`.

## Tools

| Tool | Input | Behaviour |
| --- | --- | --- |
| `get_customer_record` | `customer_id` | Returns the matching customer record. |
| `trigger_refund` | `customer_id`, `amount`, `reason` | Records a mock refund and returns it. |

## Validation

Schemas live in `src/schemas.ts` and use `.strict()` objects, so unknown
fields are rejected. Tool `inputSchema` values advertised to clients are
generated from those same schemas in `src/tools.ts`, so the two cannot drift.

| Field | Rules |
| --- | --- |
| `customer_id` | Matches `^CUST-[0-9]{5}$`. ASCII digits only. |
| `amount` | Finite, positive, at most `10000`, and no more than two decimal places (checked through the string form, so `1e-7` and `1.005` are rejected). |
| `reason` | Trimmed, minimum 10 characters, maximum 500 characters. |

## Error handling

- Invalid tool arguments and unknown tool names return JSON-RPC `-32602`
  and name the offending field in the message.
- A customer that does not exist is not an error: the tool returns a normal
  result with `isError: true`.
- Any unexpected exception returns a generic `-32603` and logs the details
  to stderr.

## Stdio isolation

stdout carries only JSON-RPC messages. All logging goes through
`src/logger.ts`, which writes exclusively to stderr. Set `LOG_LEVEL` to
`debug`, `info`, `warn`, or `error` (default `info`) to control verbosity.

## Scripts

```sh
npm start -w task1-mcp-server     # run the server on stdio
npm test -w task1-mcp-server      # spawn the server and exercise the protocol
npm run lint -w task1-mcp-server  # type check
npm run build -w task1-mcp-server # emit to dist/
```

The test suite spawns the real server, completes the initialize handshake,
lists tools, runs one valid call per tool, and sends malformed calls for
bad customer IDs, non-finite and out-of-range amounts, invalid reasons,
missing and extra fields, and unknown tools. It asserts that every stdout
line is valid JSON-RPC, and a `LOG_LEVEL=debug` run proves logs never reach
stdout.

## Sandbox data

The in-memory customer store contains `CUST-12345` (John Smith) and
`CUST-67890` (Jane Doe). Refunds are kept in memory for the life of the
process.
