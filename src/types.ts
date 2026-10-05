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

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
