import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";
import {customers} from "./customers.js";
import {logger} from "./logger.js";
import {createRefund} from "./refunds.js";
import {
  getCustomerRecordInputSchema,
  triggerRefundInputSchema,
} from "./schemas.js";
import {listTools, toolDefinitions} from "./tools.js";

function formatZodError(error: z.ZodError): string {
  return error.issues
  .map((issue) => {
    if (issue.code === "unrecognized_keys") {
      return `unexpected field(s): ${issue.keys.join(", ")}`;
    }

    const field = issue.path.length > 0 ? issue.path.join(".") : "arguments";

    return `${field}: ${issue.message}`;
  })
  .join("; ");
}

function parseArguments<T extends z.ZodType>(schema: T, args: unknown): z.output<T> {
  const parsed = schema.safeParse(args ?? {});

  if (!parsed.success) {
    throw new McpError(ErrorCode.InvalidParams, formatZodError(parsed.error));
  }

  return parsed.data;
}

const server = new Server(
  {
    name: "customer-support-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: listTools(),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const {name, arguments: args} = request.params;

  try {
    const tool = toolDefinitions.find((candidate) => candidate.name === name);

    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    logger.debug(`tools/call ${name}`);

    if (tool.name === "get_customer_record") {
      const data = parseArguments(getCustomerRecordInputSchema, args);
      const customer = customers.get(data.customer_id);

      if (!customer) {
        logger.debug(`Customer ${data.customer_id} not found`);
        return {
          content: [
            {
              type: "text",
              text: `Customer ${data.customer_id} not found.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(customer, null, 2),
          },
        ],
      };
    }

    if (tool.name === "trigger_refund") {
      const data = parseArguments(triggerRefundInputSchema, args);
      const customer = customers.get(data.customer_id);

      if (!customer) {
        logger.debug(`Customer ${data.customer_id} not found`);
        return {
          content: [
            {
              type: "text",
              text: `Customer ${data.customer_id} not found.`,
            },
          ],
          isError: true,
        };
      }

      const refund = createRefund(data.customer_id, data.amount, data.reason);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(refund, null, 2),
          },
        ],
      };
    }

    throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }

    logger.error(`Unexpected failure in tools/call ${name}`, error);

    throw new McpError(ErrorCode.InternalError, "Internal server error");
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();

  await server.connect(transport);

  logger.info("Customer support MCP server running on stdio");
}

main().catch((error: unknown) => {
  logger.error("Server startup failed", error);
  process.exitCode = 1;
});