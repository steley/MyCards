import { Hono } from 'hono';
import type { Env } from '../types';
import { ApiError } from '../types';
import { COLORS, yuanToCents } from '../util';

type App = Hono<{ Bindings: Env['Bindings'] }>;

export const cardRoutes: App = new Hono();

function optInt(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, `数值需在 ${min}-${max} 之间`);
  return n;
}

function parseCardBody(body: any) {
  const name = String(body?.name ?? '').trim();
  if (!name || name.length > 40) throw new ApiError(400, '卡片名称必填，40 字以内');
  const issuer = String(body?.issuer ?? '').trim().slice(0, 40);
  const last4 = String(body?.last4 ?? '').trim();
  if (last4 && !/^\d{4}$/.test(last4)) throw new ApiError(400, '尾号必须是 4 位数字');

  const billing_day = optInt(body?.billing_day, 1, 31);
  const due_offset_days = optInt(body?.due_offset_days, 1, 31);
  const due_day = due_offset_days == null ? optInt(body?.due_day, 1, 31) : null;
  if (due_offset_days != null && billing_day == null) throw new ApiError(400, '使用「账单日+N 天」需先设置账单日');
  if (due_day == null && due_offset_days == null) throw new ApiError(400, '请设置固定还款日或账单日+N 天，否则无法提醒');

  let credit_limit_cents = 0;
  if (body?.credit_limit != null && body.credit_limit !== '') {
    credit_limit_cents = yuanToCents(body.credit_limit) ?? (() => { throw new ApiError(400, '信用额度无效'); })();
  }

  return {
    name,
    issuer,
    last4,
    billing_day,
    due_day,
    due_offset_days,
    credit_limit_cents,
    color: COLORS.includes(body?.color) ? body.color : 'blue',
    note: String(body?.note ?? '').slice(0, 200),
  };
}

const SELECT_ALL = 'SELECT * FROM cards';
const INSERT = `INSERT INTO cards (name, issuer, last4, billing_day, due_day, due_offset_days, credit_limit_cents, color, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPDATE = `UPDATE cards SET name=?, issuer=?, last4=?, billing_day=?, due_day=?, due_offset_days=?,
  credit_limit_cents=?, color=?, note=?, archived=? WHERE id=?`;

cardRoutes.get('/cards', async (c) => {
  const sql = c.req.query('archived') === '1' ? `${SELECT_ALL} ORDER BY archived, id` : `${SELECT_ALL} WHERE archived=0 ORDER BY id`;
  const { results } = await c.env.DB.prepare(sql).all();
  return c.json({ cards: results });
});

cardRoutes.post('/cards', async (c) => {
  const d = parseCardBody(await c.req.json());
  const { meta } = await c.env.DB.prepare(INSERT)
    .bind(d.name, d.issuer, d.last4, d.billing_day, d.due_day, d.due_offset_days, d.credit_limit_cents, d.color, d.note)
    .run();
  const card = await c.env.DB.prepare('SELECT * FROM cards WHERE id=?').bind(meta.last_row_id).first();
  return c.json({ card }, 201);
});

cardRoutes.put('/cards/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await c.env.DB.prepare('SELECT * FROM cards WHERE id=?').bind(id).first<any>();
  if (!existing) throw new ApiError(404, '卡片不存在');
  const body = await c.req.json();
  const d = parseCardBody(body);
  const archived = body?.archived === undefined ? existing.archived : body?.archived ? 1 : 0;
  await c.env.DB.prepare(UPDATE)
    .bind(d.name, d.issuer, d.last4, d.billing_day, d.due_day, d.due_offset_days, d.credit_limit_cents, d.color, d.note, archived, id)
    .run();
  const card = await c.env.DB.prepare('SELECT * FROM cards WHERE id=?').bind(id).first();
  return c.json({ card });
});

// 删除（AUDIT-006）：单语句原子化——无账单才硬删，消除 COUNT→DELETE 竞态窗口；
// 有账单的卡片改为归档，历史账单与统计保留
cardRoutes.delete('/cards/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const { meta } = await c.env.DB.prepare(
    'DELETE FROM cards WHERE id = ? AND NOT EXISTS (SELECT 1 FROM bills WHERE card_id = cards.id)',
  ).bind(id).run();
  if (meta.changes) return c.json({ ok: true, deleted: true });
  const existing = await c.env.DB.prepare('SELECT id FROM cards WHERE id = ?').bind(id).first();
  if (!existing) throw new ApiError(404, '卡片不存在');
  await c.env.DB.prepare('UPDATE cards SET archived=1 WHERE id=?').bind(id).run();
  return c.json({ ok: true, deleted: false });
});
