# Task 2: Security Gateway Proxy

An HTTP gateway that authenticates MCP clients, validates JSON-RPC, denies
non-admin access to `admin_*` tools, and forwards allowed requests to a
downstream MCP server.

## Run

```sh
npm run start:mock
npm run start
```

The gateway listens on `PORT` (default `3000`) and forwards to
`DOWNSTREAM_URL` (default `http://localhost:4000/mcp`). Set
`DOWNSTREAM_TIMEOUT_MS` to change the downstream timeout (default `10000`).

```sh
npm test
npm run typecheck
```

## Authentication

The `Authorization` header must match exactly `Bearer <token>`. Tokens are
resolved through the token-to-role map in `src/auth.ts`.

- `admin-secret` maps to `admin`.
- `viewer-secret` maps to `viewer`.
- Any other token, a missing header, or a malformed header returns HTTP `401`
  with a JSON-RPC error body.
- Any role other than `admin` is treated as `viewer` (deny by default).

The gateway never forwards the `Authorization` header downstream.

## JSON-RPC handling

| Condition | Code | HTTP status |
| --- | --- | --- |
| Invalid JSON | `-32700` | `400` |
| Non-object request, `jsonrpc` other than `"2.0"`, non-string `method`, or batch array | `-32600` | `400` |
| Invalid `tools/call` name | `-32602` | `200` |
| Non-admin calling an `admin_*` tool | `-32001` | `200` |
| Downstream failure or timeout | `-32603` | `502` |

`tools/list` and all methods other than `tools/call` are forwarded unchanged.
`tools/call` requires `params.name` to be a string of 1-128 characters matching
`[A-Za-z0-9_-]`. Admin checks are case-insensitive, so `Admin_` is denied to
viewers as well.

Notifications (requests without an `id`) are forwarded and return HTTP `202`
with no JSON-RPC body.

## Forwarding

The gateway forwards `Content-Type`, `Accept`, `Mcp-Session-Id`, and
`MCP-Protocol-Version`. It returns the downstream status, end-to-end headers,
and streams the downstream body through, including SSE responses.

## Scope and limits

- Target MCP revision: **2025-06-18**. This revision removed JSON-RPC batching,
  so the gateway rejects batch arrays with `-32600` instead of forwarding them.
- Only `POST` is handled. Other HTTP methods return `405`. This is an
  intentional limit; a full MCP streamable HTTP transport may also handle
  `GET` for server-initiated streams and `DELETE` for session termination.
- The downstream timeout covers connection and response-header time, not the
  duration of a long-lived streamed body.