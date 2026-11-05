import { randomUUID } from "node:crypto";

export type Refund = {
  refund_id: string;
  customer_id: string;
  amount: number;
  reason: string;
  status: "processed";
};

export const refunds: Refund[] = [];

export function createRefund(
  customer_id: string,
  amount: number,
  reason: string
): Refund {
  const refund: Refund = {
    refund_id: randomUUID(),
    customer_id,
    amount,
    reason,
    status: "processed",
  };

  refunds.push(refund);

  return refund;
}
