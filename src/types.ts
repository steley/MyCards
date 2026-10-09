export type Env = {
  Bindings: {
    DB: D1Database;
    AUTH_PASSWORD: string;
    TZ_OFFSET?: string;
    DM_ACCESS_KEY_ID?: string;
    DM_ACCESS_KEY_SECRET?: string;
    DM_FROM?: string;
    MAIL_TO?: string;
    CRON_TOKEN?: string;
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
