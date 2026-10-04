const COOKIE_NAME = 'session';
const SESSION_DAYS = 30;
const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 会话签名密钥（AUDIT-002）：从登录密码经 HKDF 派生独立 HMAC 密钥，
// 不再以口令本身作密钥——令牌即使泄露也无法被用作密码的离线验证 oracle。
// 派生结果按 secret 缓存（isolate 生命周期内复用；改密码自动重新派生，旧令牌全失效）。
let keyCache: { secret: string; key: CryptoKey } | null = null;

async function sessionKey(secret: string): Promise<CryptoKey> {
  if (keyCache?.secret === secret) return keyCache.key;
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('mycards-session-v1'), info: enc.encode('session-signing') },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  keyCache = { secret, key };
  return key;
}

async function hmac(secret: string, msg: string): Promise<string> {
  return toHex(await crypto.subtle.sign('HMAC', await sessionKey(secret), enc.encode(msg)));
}

/** 先对两边做 SHA-256 再逐字节比较，避免长度泄漏且比较本身恒时 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}

async function signature(secret: string, exp: number): Promise<string> {
  return hmac(secret, `${COOKIE_NAME}:${exp}`);
}

function readToken(cookieHeader: string): string | null {
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return m ? m[1]! : null;
}

/** 读出会话过期时间（Unix 秒），无效返回 null */
export function sessionExp(cookieHeader: string): number | null {
  const token = readToken(cookieHeader);
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const exp = Number(token.slice(0, dot));
  return Number.isInteger(exp) ? exp : null;
}

export async function sessionCookie(secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400;
  const token = `${exp}.${await signature(secret, exp)}`;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function verifySessionCookie(cookieHeader: string, secret: string): Promise<boolean> {
  const token = readToken(cookieHeader);
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isInteger(exp) || exp < Date.now() / 1000) return false;
  return timingSafeEqual(token.slice(dot + 1), await signature(secret, exp));
}

export async function verifyPassword(input: string, secret: string): Promise<boolean> {
  return timingSafeEqual(input, secret);
}
