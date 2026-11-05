import {z} from "zod";

export const MAX_REFUND_AMOUNT = 10000;

export const customerIdSchema = z
.string()
.regex(/^CUST-[0-9]{5}$/, "customer_id must look like CUST-12345");

function hasAtMostTwoDecimals(value: number): boolean {
  return /^[0-9]+(\.[0-9]{1,2})?$/.test(String(value));
}

export const refundAmountSchema = z
.number()
.finite()
.positive()
.max(MAX_REFUND_AMOUNT, `amount must be at most ${MAX_REFUND_AMOUNT}`)
.refine(hasAtMostTwoDecimals, "amount must have no more than two decimal places");

export const refundReasonSchema = z
.string()
.trim()
.min(10, "reason must be at least 10 characters")
.max(500, "reason must be at most 500 characters");

export const getCustomerRecordInputSchema = z
.object({
  customer_id: customerIdSchema,
})
.strict();

export const triggerRefundInputSchema = z
.object({
  customer_id: customerIdSchema,
  amount: refundAmountSchema,
  reason: refundReasonSchema,
})
.strict();