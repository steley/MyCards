import { Hono } from 'hono';
import type { Env } from '../types';
import { ApiError } from '../types';
import { computeDueDate, csvEscape, diffDays, todayYMD, tzOffsetHours } from '../util';

type App = Hono<{ Bindings: Env['Bindings'] }>;

export const statRoutes: App = new Hono();

statRoutes.get('/dashboard', async (c) => {
  const today = todayYMD(tzOffsetHours(c.env.TZ_OFFSET));
  const period = today.slice(0, 7);

  // 三条只读查询合并为一次 D1 往返（batch 同事务顺序执行），省去逐条等待
  const [monthTotalRes, unpaidTotalRes, unpaidListRes] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COALESCE(SUM(amount_cents),0) AS t FROM bills WHERE period=?').bind(period),
    c.env.DB.prepare('SELECT COALESCE(SUM(amount_cents - paid_amount_cents),0) AS t FROM bills WHERE paid=0'),
    c.env.DB.prepare(
      `SELECT b.id, b.card_id, b.period, b.amount_cents, b.due_date,
              c.name AS card_name, c.color, c.billing_day, c.due_day, c.due_offset_days
       FROM bills b JOIN cards c ON c.id = b.card_id WHERE b.paid = 0`,
    ),
  ]);
  const monthTotal = monthTotalRes.results[0] as { t: number } | undefined;
  const unpaidTotal = unpaidTotalRes.results[0] as { t: number } | undefined;
  const unpaid = unpaidListRes.results as any[];

  const dueSoon: any[] = [];
  for (const row of unpaid) {
    const due = computeDueDate(row, row.period, row.due_date);
    if (!due) continue;
    const days = diffDays(due, today);
    if (days <= 7) {
      dueSoon.push({
        id: row.id, card_id: row.card_id, card_name: row.card_name, color: row.color,
        period: row.period, amount_cents: row.amount_cents, due_date: due, days,
      });
    }
  }
  dueSoon.sort((a, b) => a.due_date.localeCompare(b.due_date));

  return c.json({
    today,
    period,
    month_total_cents: monthTotal?.t ?? 0,
    unpaid_total_cents: unpaidTotal?.t ?? 0,
    due_soon: dueSoon,
  });
});

statRoutes.get('/stats', async (c) => {
  const yearParam = Number(c.req.query('year'));
  const year = Number.isInteger(yearParam) && yearParam >= 2000 && yearParam <= 2999
    ? yearParam
    : Number(todayYMD(tzOffsetHours(c.env.TZ_OFFSET)).slice(0, 4));

  const { results } = await c.env.DB.prepare(
    `SELECT b.card_id, c.name, c.issuer, c.color, substr(b.period, 6, 2) AS mm, SUM(b.amount_cents) AS cents
     FROM bills b JOIN cards c ON c.id = b.card_id
     WHERE b.period LIKE ? GROUP BY b.card_id, b.period`,
  ).bind(`${year}-%`).all();

  const monthly = Array<number>(12).fill(0);
  const byCard = new Map<number, any>();
  for (const r of results as any[]) {
    const mi = Number(r.mm) - 1;
    monthly[mi] += r.cents;
    const card = byCard.get(r.card_id) ?? { card_id: r.card_id, name: r.name, issuer: r.issuer, color: r.color, monthly: Array<number>(12).fill(0), total: 0 };
    card.monthly[mi] += r.cents;
    card.total += r.cents;
    byCard.set(r.card_id, card);
  }

  return c.json({
    year,
    // AUDIT-004：下发服务端「今天」，前端当月高亮/默认期以此为准
    today: todayYMD(tzOffsetHours(c.env.TZ_OFFSET)),
    monthly_cents: monthly,
    total_cents: monthly.reduce((a, b) => a + b, 0),
    by_card: [...byCard.values()].sort((a, b) => b.total - a.total),
  });
});

// 全量 CSV 导出（含 BOM，Excel 直接打开不乱码）
statRoutes.get('/export', async (c) => {
  // 两条只读查询合并为一次 D1 往返
  const [cardsRes, billsRes] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM cards ORDER BY id'),
    c.env.DB.prepare(
      'SELECT b.*, c.name AS card_name FROM bills b JOIN cards c ON c.id = b.card_id ORDER BY b.period, b.card_id',
    ),
  ]);
  const cards = cardsRes.results as any[];
  const bills = billsRes.results as any[];

  const lines: string[] = ['## 卡片'];
  lines.push(['id', '名称', '发卡行', '尾号', '账单日', '还款日', '账单日+N天', '额度(元)', '颜色', '备注', '已归档', '创建时间'].join(','));
  for (const k of cards as any[]) {
    lines.push([
      k.id, k.name, k.issuer, k.last4, k.billing_day ?? '', k.due_day ?? '', k.due_offset_days ?? '',
      k.credit_limit_cents ? k.credit_limit_cents / 100 : '', k.color, k.note, k.archived ? '是' : '否', k.created_at,
    ].map(csvEscape).join(','));
  }
  lines.push('');
  lines.push('## 账单');
  lines.push(['id', '账单期', '卡片', '金额(元)', '还款日', '已还清', '已还金额(元)', '还款时间', '备注'].join(','));
  for (const b of bills as any[]) {
    lines.push([
      b.id, b.period, b.card_name, b.amount_cents / 100, b.due_date ?? '',
      b.paid ? '是' : '否', b.paid_amount_cents / 100, b.paid_at ?? '', b.note ?? '',
    ].map(csvEscape).join(','));
  }

  const csv = '\uFEFF' + lines.join('\r\n');
  const date = todayYMD(tzOffsetHours(c.env.TZ_OFFSET)).replace(/-/g, '');
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="mycards-${date}.csv"`,
    },
  });
});
