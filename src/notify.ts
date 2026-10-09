import type { Env } from './types';
import { computeDueDate, diffDays, todayYMD, tzOffsetHours } from './util';

// 还款提醒推送（Server酱）：还款日前 2 天、前 1 天、当天各推，逾期未还持续推。
// 由 Cron Triggers 每天北京时间 8 点、20 点触发（见 wrangler.jsonc），无 HTTP 端点、无调用方。
export async function sendReminders(env: Env['Bindings']): Promise<void> {
  if (!env.SENDKEY) throw new Error('未配置 SENDKEY，无法推送还款提醒');
  const today = todayYMD(tzOffsetHours(env.TZ_OFFSET));

  const { results } = await env.DB.prepare(
    `SELECT b.period, b.amount_cents, b.due_date,
            c.name AS card_name, c.billing_day, c.due_day, c.due_offset_days
     FROM bills b JOIN cards c ON c.id = b.card_id
     WHERE b.paid = 0 AND b.no_bill = 0`,
  ).all();

  const lines: string[] = [];
  for (const r of results as any[]) {
    const due = computeDueDate(r, r.period, r.due_date);
    if (!due) continue;
    const days = diffDays(due, today);
    if (days > 2) continue; // 0 = 今天到期；负数 = 已逾期，一并推避免逾期后静默
    const when = days === 0 ? '今天到期' : days > 0 ? `还有 ${days} 天` : `已逾期 ${-days} 天`;
    lines.push(`- ${r.card_name} ${r.period} 应还 ¥${(r.amount_cents / 100).toFixed(2)}，${when}（${due}）`);
  }
  if (!lines.length) return;

  const body = new URLSearchParams({ title: '信用卡还款提醒', desp: lines.join('\n') });
  const res = await fetch(`https://sctapi.ftqq.com/${env.SENDKEY}.send`, { method: 'POST', body });
  if (!res.ok) console.error('Server酱推送失败', res.status, await res.text());
}
