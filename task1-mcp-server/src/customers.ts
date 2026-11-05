export type Customer = {
  customer_id: string;
  name: string;
  email: string;
  status: string;
};

export const customers = new Map<string, Customer>([
  [
    "CUST-12345",
    {
      customer_id: "CUST-12345",
      name: "John Smith",
      email: "john@example.com",
      status: "active",
    },
  ],
  [
    "CUST-67890",
    {
      customer_id: "CUST-67890",
      name: "Jane Doe",
      email: "jane@example.com",
      status: "active",
    },
  ],
]);
