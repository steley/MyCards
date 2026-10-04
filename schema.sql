-- 信用卡管家数据表（D1 / SQLite）
-- 执行：npx wrangler d1 execute mycards --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                          -- 卡片名称
  issuer TEXT NOT NULL DEFAULT '',             -- 发卡行
  last4 TEXT NOT NULL DEFAULT '',              -- 卡号尾号 4 位
  billing_day INTEGER,                         -- 账单日 1-31
  due_day INTEGER,                             -- 固定还款日 1-31（与下者二选一）
  due_offset_days INTEGER,                     -- 还款日 = 账单日 + N 天
  credit_limit_cents INTEGER NOT NULL DEFAULT 0, -- 信用额度（分）
  color TEXT NOT NULL DEFAULT 'blue',          -- 卡面颜色 blue/violet/green/orange/rose/cyan
  note TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,         -- 1 = 已归档（保留历史数据）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 月账单：每张卡每月一条
CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  period TEXT NOT NULL,                        -- 账单归属期 'YYYY-MM'
  amount_cents INTEGER NOT NULL DEFAULT 0,     -- 账单金额（分）
  due_date TEXT,                               -- 实际还款日（可覆盖自动推算）
  paid INTEGER NOT NULL DEFAULT 0,             -- 是否已还清
  paid_amount_cents INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,                                -- 标记还款的时间
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(card_id, period),
  FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bills_period ON bills(period);
CREATE INDEX IF NOT EXISTS idx_bills_card ON bills(card_id, period);

-- 登录失败限速（AUDIT-001：按来源 IP，5 次失败锁 15 分钟）
CREATE TABLE IF NOT EXISTS login_throttle (
  ip TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0
);
