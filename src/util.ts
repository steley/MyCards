import type { CardRow } from './types';

export const COLORS = ['blue', 'violet', 'green', 'orange', 'rose', 'cyan', 'gold', 'slate', 'indigo', 'crimson', 'forest', 'plum'];
export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function tzOffsetHours(offset?: string): number {
  const n = Number(offset);
  return Number.isFinite(n) && n >= -12 && n <= 14 ? n : 8;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 按 TZ_OFFSET 得到「今天」，如 2026-10-04 */
export function todayYMD(offsetHours: number): string {
  return new Date(Date.now() + offsetHours * 3_600_000).toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000);
}

/**
 * 还款日推算，优先级：账单上的覆盖值 > 账单日 + N 天 > 固定还款日（短月自动钳制，如 31 日在 2 月取月末）
 */
export function computeDueDate(card: CardRow, period: string, override: string | null): string | null {
  if (override) return override;
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  if (card.due_offset_days != null && card.billing_day != null) {
    const billing = new Date(Date.UTC(year, month - 1, Math.min(card.billing_day, daysInMonth(year, month))));
    billing.setUTCDate(billing.getUTCDate() + card.due_offset_days);
    return billing.toISOString().slice(0, 10);
  }
  if (card.due_day != null) {
    return `${period}-${pad2(Math.min(card.due_day, daysInMonth(year, month)))}`;
  }
  return null;
}

/** 元 → 分；非法输入返回 null */
export function yuanToCents(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 99_999_999) return null;
  return Math.round(n * 100);
}

export function csvEscape(value: unknown): string {
  let s = String(value ?? '');
  // 公式前缀中和（AUDIT-003）：= + - @ Tab CR 开头的字段加 ' 前缀，防表格软件求值
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
