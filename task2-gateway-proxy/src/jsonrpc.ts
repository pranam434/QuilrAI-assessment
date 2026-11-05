export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method: string;
  params?: unknown;
};

export type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
  };
};

export type ParseResult =
  | { ok: true; request: JsonRpcRequest }
  | { ok: false; status: number; response: JsonRpcErrorResponse };

const toolNamePattern = /^[A-Za-z0-9_-]{1,128}$/;

export const errorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  invalidParams: -32602,
  unauthorizedToolCall: -32001,
  upstreamError: -32603,
} as const;

export function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

export function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined;
}

export function isToolNameValid(name: string): boolean {
  return toolNamePattern.test(name);
}

export function toolCallName(request: JsonRpcRequest): string | null {
  if (request.method !== "tools/call") {
    return null;
  }

  if (
    typeof request.params !== "object" ||
    request.params === null ||
    Array.isArray(request.params)
  ) {
    return null;
  }

  const name = (request.params as Record<string, unknown>).name;

  return typeof name === "string" ? name : null;
}

function normalizeId(value: unknown): JsonRpcId | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function parseJsonRpc(body: string): ParseResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      status: 400,
      response: errorResponse(null, errorCodes.parseError, "Parse error"),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 400,
      response: errorResponse(null, errorCodes.invalidRequest, "Invalid Request"),
    };
  }

  const record = parsed as Record<string, unknown>;
  const hasId = "id" in record;
  const rawId = record.id;
  const idIsValid =
    !hasId ||
    rawId === null ||
    typeof rawId === "string" ||
    typeof rawId === "number";

  if (
    record.jsonrpc !== "2.0" ||
    typeof record.method !== "string" ||
    !idIsValid
  ) {
    return {
      ok: false,
      status: 400,
      response: errorResponse(
        normalizeId(rawId),
        errorCodes.invalidRequest,
        "Invalid Request"
      ),
    };
  }

  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: record.method,
  };

  if (hasId) {
    request.id = normalizeId(rawId);
  }

  if ("params" in record) {
    request.params = record.params;
  }

  return { ok: true, request };
}