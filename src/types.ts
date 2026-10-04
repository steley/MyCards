export type Env = {
  Bindings: {
    DB: D1Database;
    AUTH_PASSWORD: string;
    TZ_OFFSET?: string;
  };
};

export type CardRow = {
  id: number;
  name: string;
  issuer: string;
  last4: string;
  billing_day: number | null;
  due_day: number | null;
  due_offset_days: number | null;
  credit_limit_cents: number;
  color: string;
  note: string;
  archived: number;
  created_at: string;
};

export type BillRow = {
  id: number;
  card_id: number;
  period: string;
  amount_cents: number;
  due_date: string | null;
  paid: number;
  paid_amount_cents: number;
  paid_at: string | null;
  note: string;
  created_at: string;
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
