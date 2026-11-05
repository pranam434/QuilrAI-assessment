import {z} from "zod";
import {
  getCustomerRecordInputSchema,
  triggerRefundInputSchema,
} from "./schemas.js";

export const toolDefinitions = [
  {
    name: "get_customer_record",
    description: "Retrieve a customer record using its customer ID.",
    schema: getCustomerRecordInputSchema,
  },
  {
    name: "trigger_refund",
    description: "Process a mock customer refund.",
    schema: triggerRefundInputSchema,
  },
] as const;

export type ToolName = (typeof toolDefinitions)[number]["name"];

export type ToolInfo = {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export function listTools(): ToolInfo[] {
  return toolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema, {io: "input"}),
  }));
}