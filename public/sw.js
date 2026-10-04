'use strict';

// PWA 静态资源缓存。
// 注意：任何静态文件（index.html / app.js / style.css / 图标）改动后，
// 必须把 VERSION 递增一档（v2、v3……）再部署，否则老用户拿不到更新。
const VERSION = 'v3';
const CACHE = `mycards-static-${VERSION}`;
const ASSETS = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 页面点击「发现新版本」横幅后，让等待中的新 SW 立即接管并触发刷新
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 只处理同源 GET；/api/* 永远直连网络——数据以 D1 为唯一来源，
  // 缓存接口响应会导致「离线看到旧数据」和登录态错乱
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // 导航请求统一用 '/' 作缓存键（服务器对任意路径都回退到首页；/index.html 会被 307 到 /）
    const req = e.request.mode === 'navigate' ? new Request('/') : e.request;
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok && ASSETS.includes(url.pathname)) cache.put(e.request, res.clone());
      return res;
    } catch {
      // 断网兜底：导航请求返回缓存的页面壳（页面自身会显示离线横幅）
      if (e.request.mode === 'navigate') {
        const fallback = await cache.match('/');
        if (fallback) return fallback;
      }
      return new Response('网络不可用', { status: 503, statusText: 'offline' });
    }
  })());
});
