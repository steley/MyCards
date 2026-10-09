import type { Env } from './types';
import { computeDueDate, diffDays, todayYMD, tzOffsetHours } from './util';

// 还款提醒邮件（阿里云 DirectMail）：还款日前 2 天、前 1 天、当天各发，逾期未还持续发。
// 由 GitHub Actions 每天北京时间 8 点、20 点经 /api/cron 触发（见 .github/workflows/notify.yml）。
// 收发件地址等全部走 secrets，不入仓库。
export async function sendReminders(env: Env['Bindings']): Promise<void> {
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
    if (days > 2) continue; // 0 = 今天到期；负数 = 已逾期，一并发避免逾期后静默
    const when = days === 0 ? '今天到期' : days > 0 ? `还有 ${days} 天` : `已逾期 ${-days} 天`;
    lines.push(`${r.card_name} ${r.period} 应还 ¥${(r.amount_cents / 100).toFixed(2)}，${when}（${due}）`);
  }
  if (!lines.length) return;

  await sendMail(env, `信用卡还款提醒：${lines.length} 笔待还`, lines.join('\n'));
}

// DirectMail RPC 接口（POST 表单 + HMAC-SHA1 签名）。发信地址需先在
// DirectMail 控制台（cn-hangzhou 区域）验证通过；发件域名在 Cloudflare 加 SPF/DKIM 记录。
async function sendMail(env: Env['Bindings'], subject: string, text: string): Promise<void> {
  if (!env.DM_ACCESS_KEY_ID || !env.DM_ACCESS_KEY_SECRET || !env.DM_FROM || !env.MAIL_TO)
    throw new Error('未配置 DM_ACCESS_KEY_ID / DM_ACCESS_KEY_SECRET / DM_FROM / MAIL_TO，无法发送提醒邮件');
  const params: Record<string, string> = {
    Action: 'SingleSendMail',
    Version: '2015-11-23',
    RegionId: 'cn-hangzhou',
    AccessKeyId: env.DM_ACCESS_KEY_ID,
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    AccountName: env.DM_FROM,
    FromAlias: '信用卡管家',
    AddressType: '1',
    ToAddress: env.MAIL_TO,
    Subject: subject,
    TextBody: text,
    Format: 'TEXT',
  };
  // 阿里云 RPC 规范的百分号编码：* 不转义、~ 还原、空格用 %20
  const enc = (s: string) => encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
  const canonical = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const toSign = `POST&${enc('/')}&${enc(canonical)}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.DM_ACCESS_KEY_SECRET + '&'),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const res = await fetch('https://dm.aliyuncs.com/', {
    method: 'POST',
    body: new URLSearchParams({ ...params, Signature: signature }),
  });
  if (!res.ok) console.error('DirectMail 发送失败', res.status, await res.text());
}
