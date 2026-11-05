import {test} from "node:test";
import assert from "node:assert/strict";

import {
  MAX_REFUND_AMOUNT,
  customerIdSchema,
  getCustomerRecordInputSchema,
  triggerRefundInputSchema,
} from "../src/schemas.js";

const validRefund = {
  customer_id: "CUST-12345",
  amount: 25.5,
  reason: "Duplicate payment",
};

test("accepts a valid customer ID", () => {
  assert.equal(customerIdSchema.safeParse("CUST-12345").success, true);
});

test("rejects a customer ID with the wrong case", () => {
  assert.equal(customerIdSchema.safeParse("cust-12345").success, false);
});

test("rejects a customer ID with a trailing newline", () => {
  assert.equal(customerIdSchema.safeParse("CUST-12345\n").success, false);
});

test("rejects a customer ID with unicode digits", () => {
  assert.equal(customerIdSchema.safeParse("CUST-\u0661\u0662\u0663\u0664\u0665").success, false);
});

test("rejects a customer ID of the wrong length", () => {
  assert.equal(customerIdSchema.safeParse("CUST-1234").success, false);
  assert.equal(customerIdSchema.safeParse("CUST-123456").success, false);
});

test("accepts valid customer record arguments", () => {
  const result = getCustomerRecordInputSchema.safeParse({
    customer_id: "CUST-12345",
  });

  assert.equal(result.success, true);
});

test("rejects additional customer record properties", () => {
  const result = getCustomerRecordInputSchema.safeParse({
    customer_id: "CUST-12345",
    admin: true,
  });

  assert.equal(result.success, false);
});

test("accepts valid refund arguments", () => {
  assert.equal(triggerRefundInputSchema.safeParse(validRefund).success, true);
});

test("accepts a refund amount at the cap", () => {
  const result = triggerRefundInputSchema.safeParse({
    ...validRefund,
    amount: MAX_REFUND_AMOUNT,
  });

  assert.equal(result.success, true);
});

test("rejects an amount above the cap", () => {
  const result = triggerRefundInputSchema.safeParse({
    ...validRefund,
    amount: MAX_REFUND_AMOUNT + 1,
  });

  assert.equal(result.success, false);
});

test("rejects NaN and infinite amounts", () => {
  for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const result = triggerRefundInputSchema.safeParse({
      ...validRefund,
      amount,
    });

    assert.equal(result.success, false);
  }
});

test("rejects zero and negative refund amounts", () => {
  for (const amount of [0, -0.01, -100]) {
    const result = triggerRefundInputSchema.safeParse({
      ...validRefund,
      amount,
    });

    assert.equal(result.success, false);
  }
});

test("rejects a string refund amount", () => {
  const result = triggerRefundInputSchema.safeParse({
    ...validRefund,
    amount: "10",
  });

  assert.equal(result.success, false);
});

test("rejects amounts with more than two decimal places", () => {
  for (const amount of [1.005, 0.001, 1e-7]) {
    const result = triggerRefundInputSchema.safeParse({
      ...validRefund,
      amount,
    });

    assert.equal(result.success, false);
  }
});

test("rejects refund reasons shorter than 10 characters after trimming", () => {
  const result = triggerRefundInputSchema.safeParse({
    ...validRefund,
    reason: "   short   ",
  });

  assert.equal(result.success, false);
});

test("rejects refund reasons longer than 500 characters", () => {
  const result = triggerRefundInputSchema.safeParse({
    ...validRefund,
    reason: "a".repeat(501),
  });

  assert.equal(result.success, false);
});

test("rejects refund requests with missing properties", () => {
  const result = triggerRefundInputSchema.safeParse({
    customer_id: "CUST-12345",
  });

  assert.equal(result.success, false);
});

test("rejects refund requests with extra properties", () => {
  const result = triggerRefundInputSchema.safeParse({
    ...validRefund,
    currency: "USD",
  });

  assert.equal(result.success, false);
});