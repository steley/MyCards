import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from './types';
import { ApiError } from './types';
import { clearCookie, sessionCookie, sessionExp, verifyPassword, verifySessionCookie } from './auth';
import { cardRoutes } from './routes/cards';
import { billRoutes } from './routes/bills';
import { statRoutes } from './routes/stats';
import { sendReminders } from './notify';

const app = new Hono<{ Bindings: Env['Bindings'] }>();

// 除登录外，全部 /api 需要有效会话
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/login') return next();
  if (!c.env.AUTH_PASSWORD) return c.json({ error: '服务端未配置 AUTH_PASSWORD 密钥' }, 500);
  if (!(await verifySessionCookie(c.req.header('Cookie') ?? '', c.env.AUTH_PASSWORD)))
    return c.json({ error: '未登录' }, 401);
  await next();
});

// 登录失败限速（AUDIT-001）：按来源 IP，5 次失败锁 15 分钟
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

app.post('/api/login', async (c) => {
  // INFO-5：未配置密码时直接 fail-closed，不给「空密码可登录」的边角
  if (!c.env.AUTH_PASSWORD) return c.json({ error: '服务端未配置 AUTH_PASSWORD' }, 500);
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const now = Date.now();
  const row = await c.env.DB.prepare('SELECT fail_count, window_start FROM login_throttle WHERE ip=?')
    .bind(ip).first<{ fail_count: number; window_start: number }>();
  if (row && row.fail_count >= LOGIN_MAX_FAILS && now - row.window_start < LOGIN_WINDOW_MS) {
    const retry = Math.ceil((LOGIN_WINDOW_MS - (now - row.window_start)) / 1000);
    return c.json({ error: `失败次数过多，请约 ${Math.ceil(retry / 60)} 分钟后再试` }, 429, {
      'Retry-After': String(retry),
    });
  }
  const body = await c.req.json().catch(() => ({}));
  if (!(await verifyPassword(String(body?.password ?? ''), c.env.AUTH_PASSWORD))) {
    if (row && now - row.window_start < LOGIN_WINDOW_MS) {
      await c.env.DB.prepare('UPDATE login_throttle SET fail_count = fail_count + 1 WHERE ip=?').bind(ip).run();
    } else {
      await c.env.DB.prepare(
        'INSERT INTO login_throttle (ip, fail_count, window_start) VALUES (?, 1, ?) ' +
          'ON CONFLICT(ip) DO UPDATE SET fail_count = 1, window_start = excluded.window_start',
      ).bind(ip, now).run();
    }
    return c.json({ error: '密码错误' }, 401);
  }
  await c.env.DB.prepare('DELETE FROM login_throttle WHERE ip=?').bind(ip).run();
  return c.json({ ok: true }, { headers: { 'Set-Cookie': await sessionCookie(c.env.AUTH_PASSWORD) } });
});

app.post('/api/logout', (c) => c.json({ ok: true }, { headers: { 'Set-Cookie': clearCookie() } }));

app.get('/api/me', async (c) => {
  // 有效期不足一半时滑动续期，长期使用不用频繁重登
  const exp = sessionExp(c.req.header('Cookie') ?? '');
  const headers: Record<string, string> = {};
  if (exp && exp - Date.now() / 1000 < 15 * 86_400) {
    headers['Set-Cookie'] = await sessionCookie(c.env.AUTH_PASSWORD);
  }
  return c.json({ ok: true }, { headers });
});

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
  console.error(err);
  return c.json({ error: '服务器内部错误' }, 500);
});

app.notFound((c) => c.json({ error: '接口不存在' }, 404));

app.route('/api', cardRoutes);
app.route('/api', billRoutes);
app.route('/api', statRoutes);

export default {
  fetch: app.fetch,
  // Cron Triggers 入口：Worker 内部触发，不走 HTTP，无需鉴权端点
  scheduled: (event: ScheduledController, env: Env['Bindings'], ctx: ExecutionContext) =>
    ctx.waitUntil(sendReminders(env)),
};
