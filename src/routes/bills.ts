import { Hono } from 'hono';
import type { Env } from '../types';
import { ApiError } from '../types';
import { PERIOD_RE, YMD_RE, computeDueDate, todayYMD, tzOffsetHours, yuanToCents } from '../util';

type App = Hono<{ Bindings: Env['Bindings'] }>;

// 写入后按 card_id+period 回读账单（batch 同事务，回读可见本次写入）
const READBACK_SQL = `SELECT b.*, c.name AS card_name, c.color FROM bills b JOIN cards c ON c.id = b.card_id
  WHERE b.card_id = ? AND b.period = ?`;

export const billRoutes: App = new Hono();

billRoutes.get('/bills', async (c) => {
  // AUDIT-004：today 由服务端按时区口径计算并随响应下发，前端不再自算 UTC 日期
  const today = todayYMD(tzOffsetHours(c.env.TZ_OFFSET));
  const period = c.req.query('period') ?? today.slice(0, 7);
  if (!PERIOD_RE.test(period)) throw new ApiError(400, 'period 格式应为 YYYY-MM');

  // 账单与卡片两条只读查询合并为一次 D1 往返
  const [billsRes, cardsRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT b.*, c.name AS card_name, c.color FROM bills b JOIN cards c ON c.id = b.card_id
       WHERE b.period = ? ORDER BY c.id`,
    ).bind(period),
    c.env.DB.prepare('SELECT * FROM cards ORDER BY id'),
  ]);
  const bills = billsRes.results as any[];
  const cards = cardsRes.results as any[];
  const dueDates: Record<number, string | null> = {};
  for (const card of cards as any[]) dueDates[card.id] = computeDueDate(card, period, null);

  return c.json({ period, today, bills, dueDates });
});

// 录入 / 修改某卡某月账单：
//  - amount 为空且未显式传 no_bill → 删除该条记录
//  - no_bill=true → 标记本月无账单（金额清零）
//  - no_bill=false 且 amount 为空 → 取消无账单标记，回到「未录入」（删除记录）
billRoutes.put('/bills', async (c) => {
  const body = await c.req.json();
  const cardId = Number(body?.card_id);
  const period = String(body?.period ?? '');
  if (!Number.isInteger(cardId)) throw new ApiError(400, 'card_id 无效');
  if (!PERIOD_RE.test(period)) throw new ApiError(400, 'period 格式应为 YYYY-MM');

  // 卡片与现有账单合并为一次读取往返
  const [cardRes, existingRes] = await c.env.DB.batch<any>([
    c.env.DB.prepare('SELECT * FROM cards WHERE id=?').bind(cardId),
    c.env.DB.prepare('SELECT * FROM bills WHERE card_id=? AND period=?').bind(cardId, period),
  ]);
  if (!cardRes.results.length) throw new ApiError(404, '卡片不存在');
  const existing = existingRes.results[0] ?? null;

  const dueDate = body?.due_date ? String(body.due_date) : null;
  if (dueDate && !YMD_RE.test(dueDate)) throw new ApiError(400, 'due_date 格式应为 YYYY-MM-DD');
  const note = String(body?.note ?? '').slice(0, 200);
  const noBill = body?.no_bill === true;

  if (body?.amount == null || body?.amount === '') {
    if (!noBill) {
      // 普通清空（或取消「无账单」标记）：删除记录，回到「未录入」
      await c.env.DB.prepare('DELETE FROM bills WHERE card_id=? AND period=?').bind(cardId, period).run();
      return c.json({ ok: true, deleted: true });
    }
    // 标记无账单：金额与还款状态一并清零
    const write = existing
      ? c.env.DB.prepare(
          'UPDATE bills SET amount_cents=0, paid=0, paid_amount_cents=0, paid_at=NULL, no_bill=1 WHERE id=?',
        ).bind(existing.id)
      : c.env.DB.prepare('INSERT INTO bills (card_id, period, amount_cents, no_bill) VALUES (?, ?, 0, 1)')
          .bind(cardId, period);
    const [, readBackRes] = await c.env.DB.batch([
      write,
      c.env.DB.prepare(READBACK_SQL).bind(cardId, period),
    ]);
    return c.json({ ok: true, bill: readBackRes.results[0] });
  }

  const cents = yuanToCents(body.amount);
  if (cents == null) throw new ApiError(400, '金额无效');

  // 还款状态转移（AUDIT-005）：
  //  - 已还总额（含此前部分还款）≥ 新金额 → 视为结清
  //  - 此前有部分还款 → 保留 paid_amount_cents（不再静默清零，包括金额未变的空修改）
  //  - 无任何还款记录 → 全零
  const prevPaid = existing ? existing.paid_amount_cents : 0;
  const prevPaidAt = existing ? existing.paid_at : null;
  let paid = 0;
  let paidCents = 0;
  let paidAt: string | null = null;
  if (cents > 0 && prevPaid >= cents) {
    paid = 1;
    paidCents = prevPaid;
    paidAt = prevPaidAt;
  } else if (prevPaid > 0) {
    paidCents = prevPaid;
    paidAt = prevPaidAt;
  }

  // 写入与回读合并为一次往返（batch 同事务顺序执行，回读可见本次写入）
  const write = existing
    ? c.env.DB.prepare(
        'UPDATE bills SET amount_cents=?, due_date=?, note=?, paid=?, paid_amount_cents=?, paid_at=?, no_bill=0 WHERE id=?',
      ).bind(cents, dueDate, note, paid, paidCents, paidAt, existing.id)
    : c.env.DB.prepare(
        'INSERT INTO bills (card_id, period, amount_cents, due_date, note) VALUES (?, ?, ?, ?, ?)',
      ).bind(cardId, period, cents, dueDate, note);
  const [, readBackRes] = await c.env.DB.batch([
    write,
    c.env.DB.prepare(READBACK_SQL).bind(cardId, period),
  ]);
  return c.json({ ok: true, bill: readBackRes.results[0] });
});

// 标记还款：{ paid: true/false, paid_amount?: 元 }；传 paid_amount 时按金额自动判断是否结清
billRoutes.post('/bills/:id/pay', async (c) => {
  const id = Number(c.req.param('id'));
  const bill = await c.env.DB.prepare('SELECT * FROM bills WHERE id=?').bind(id).first<any>();
  if (!bill) throw new ApiError(404, '账单不存在');

  const body = await c.req.json().catch(() => ({}));
  let paid = 0;
  let paidCents = 0;
  if (body?.paid_amount != null) {
    paidCents = yuanToCents(body.paid_amount) ?? 0;
    paid = paidCents > 0 && paidCents >= bill.amount_cents ? 1 : 0;
  } else if (body?.paid) {
    paid = 1;
    paidCents = bill.amount_cents;
  }
  // 更新与回读合并为一次往返（batch 同事务，回读可见本次更新）
  const [, updatedRes] = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE bills SET paid=?, paid_amount_cents=?, paid_at=? WHERE id=?')
      .bind(paid, paidCents, paid ? new Date().toISOString() : null, id),
    c.env.DB.prepare(
      `SELECT b.*, c.name AS card_name, c.color FROM bills b JOIN cards c ON c.id = b.card_id WHERE b.id = ?`,
    ).bind(id),
  ]);
  return c.json({ ok: true, bill: updatedRes.results[0] });
});
