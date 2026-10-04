'use strict';

/* ================= 工具 ================= */
const $ = (sel, el = document) => el.querySelector(sel);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
));

const fmt = (cents) => '¥' + (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* 柱状图标签用的紧凑金额：1363651 分 → 1.4万，410000 分 → 4.1k */
const fmtShort = (cents) => {
  const yuan = cents / 100;
  if (yuan >= 10000) return (yuan / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  if (yuan >= 1000) return (yuan / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(yuan));
};

const toYuanInput = (cents) => cents ? String(+(cents / 100).toFixed(2)) : '';

const COLORS = ['blue', 'violet', 'green', 'orange', 'rose', 'cyan', 'gold', 'slate', 'indigo', 'crimson', 'forest', 'plum'];
const COLOR_NAMES = {
  blue: '蓝', violet: '紫', green: '绿', orange: '橙', rose: '玫红', cyan: '青',
  gold: '金', slate: '灰', indigo: '靛', crimson: '红', forest: '墨绿', plum: '梅紫',
};

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

/* ================= API ================= */
let loggedIn = false;

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
  } catch {
    // 服务器不可达（系统断网或网络故障）：navigator.onLine 感知不到后者
    $('#offline-banner').classList.remove('hidden');
    throw new Error('网络不可用');
  }
  $('#offline-banner').classList.add('hidden');
  if (res.status === 401 && path !== '/api/login') {
    loggedIn = false;
    showLogin();
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

/* ================= 登录 ================= */
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#password').focus();
}

function showApp() {
  loggedIn = true;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

async function onLogin(e) {
  e.preventDefault();
  const errEl = $('#login-error');
  errEl.classList.add('hidden');
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#password').value = '';
    showApp();
    route();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

async function onLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  showLogin();
}

/* ================= 弹窗 ================= */
function openModal(html) {
  $('#modal-root').innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`;
  $('.modal-mask').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
}

function closeModal() { $('#modal-root').innerHTML = ''; }

function confirmModal(text, onOk, danger = true) {
  openModal(`
    <h3>确认操作</h3>
    <p>${esc(text)}</p>
    <div class="modal-actions">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">确定</button>
    </div>`);
  $('[data-act="cancel"]').onclick = closeModal;
  $('[data-act="ok"]').onclick = async () => { closeModal(); await onOk(); };
}

/* ================= 路由与缓存 ================= */
const VIEWS = ['dashboard', 'cards', 'bills', 'stats'];
const state = {
  view: null,
  billPeriod: null,
  statsYear: null,
  cards: null,          // 全部卡片（含归档）缓存
  dashboard: null,
  bills: {},            // period -> { bills, dueDates }
  stats: {},            // year -> stats 数据
  cardMode: localStorage.getItem('mycards-card-mode') === 'list' ? 'list' : 'grid',
  statsMonth: null,     // 统计页选中的月份（0-11）
};
// 本地写入序号：后台刷新回来时若期间发生过本地写入，则丢弃本次网络结果，避免覆盖最新状态
const writeSeq = { cards: 0, bills: 0 };

async function route() {
  if (!loggedIn) return;
  let view = location.hash.replace(/^#\//, '') || 'dashboard';
  if (!VIEWS.includes(view)) { location.hash = '#/dashboard'; return; }
  state.view = view;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (view === 'dashboard') renderDashboard();
  else if (view === 'cards') renderCards();
  else if (view === 'bills') renderBills();
  else if (view === 'stats') renderStats();
}

function updateBadge(count) {
  document.title = count > 0 ? `(${count}) 信用卡管家` : '信用卡管家';
}

/* ================= 仪表盘 ================= */
function renderDashboard() {
  if (state.dashboard) drawDashboard(state.dashboard);
  else $('#view').innerHTML = '<div class="empty">加载中…</div>';
  refreshDashboard();
}

async function refreshDashboard() {
  try {
    const d = await api('/api/dashboard');
    state.dashboard = d;
    if (state.view === 'dashboard') drawDashboard(d);
  } catch (err) {
    if (err.message !== '未登录') toast(err.message, true);
  }
}

function dueBadge(days) {
  const cls = days < 0 ? 'red' : days <= 3 ? 'orange' : 'yellow';
  const txt = days < 0 ? `已逾期 ${-days} 天` : days === 0 ? '今天到期' : `剩 ${days} 天`;
  return `<span class="badge ${cls}">${txt}</span>`;
}

function drawDashboard(d) {
  updateBadge(d.due_soon.length);
  $('#view').innerHTML = `
    <div class="stat-bar">
      <div class="stat-cell">
        <div class="stat-label">本月账单合计</div>
        <div class="stat-value">${fmt(d.month_total_cents)}</div>
        <div class="stat-sub">${esc(d.period)} 记录的账单</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">未还总额</div>
        <div class="stat-value ${d.unpaid_total_cents > 0 ? 'warn' : ''}">${fmt(d.unpaid_total_cents)}</div>
        <div class="stat-sub">全部未结清账单</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">7 天内到期</div>
        <div class="stat-value">${d.due_soon.length}</div>
        <div class="stat-sub">笔${d.due_soon.length ? '，含逾期' : ''}</div>
      </div>
    </div>
    <section class="panel">
      <div class="panel-head">
        <h2>还款提醒</h2>
        <div style="display:flex; gap:8px">
          <a class="btn" href="/api/export">导出备份</a>
          <a class="btn btn-primary" href="#/bills">记本月账单</a>
        </div>
      </div>
      ${d.due_soon.length
        ? `<ul class="due-list">${d.due_soon.map(dueItem).join('')}</ul>`
        : '<div class="empty">✓ 近 7 天无待还款，也没有逾期</div>'}
    </section>`;

  // 勾选即标记还款：写库后刷新仪表盘（条目移出提醒列表），账单页进入时自动同步勾选
  document.querySelectorAll('[data-pay]').forEach((cb) => {
    cb.onchange = async () => {
      try {
        await api(`/api/bills/${cb.dataset.pay}/pay`, { method: 'POST', body: JSON.stringify({ paid: cb.checked }) });
        writeSeq.bills++;
        toast(cb.checked ? '已标记还款 🎉' : '已取消还款标记');
        refreshDashboard();
      } catch (err) {
        toast(err.message, true);
        cb.checked = !cb.checked;
      }
    };
  });
}

function dueItem(b) {
  return `
    <li class="due-item">
      <span class="dot ${esc(b.color)}"></span>
      <div>
        <b>${esc(b.card_name)}</b>
        <small>${esc(b.period)} 账单 · 应还 ${fmt(b.amount_cents)} · ${esc(b.due_date)}</small>
      </div>
      ${dueBadge(b.days)}
      <label class="due-pay"><input type="checkbox" data-pay="${b.id}"> 已还款</label>
    </li>`;
}

/* ================= 卡片管理 ================= */
function dueDesc(c) {
  return c.due_offset_days != null ? `账单日+${c.due_offset_days} 天` : `每月 ${c.due_day} 日`;
}

function cardFace(c) {
  return `
    <div class="credit-card ${esc(c.color)}">
      <div class="cc-top"><b>${esc(c.name)}</b><span>${esc(c.issuer)}</span></div>
      <div class="cc-chip"></div>
      <div class="cc-num">•••• •••• •••• ${esc(c.last4 || '····')}</div>
      <div class="cc-bottom">
        <span>账单日 ${c.billing_day ?? '—'} · 还款 ${esc(dueDesc(c))}</span>
        <span>${c.credit_limit_cents ? '额度 ' + fmt(c.credit_limit_cents) : ''}</span>
      </div>
    </div>`;
}

function renderCards() {
  if (state.cards) drawCards();
  else $('#view').innerHTML = '<div class="empty">加载中…</div>';
  refreshCards();
}

async function refreshCards() {
  const seq = writeSeq.cards;
  try {
    const { cards } = await api('/api/cards?archived=1');
    if (seq !== writeSeq.cards) return; // 刷新期间有本地写入，丢弃本次结果
    state.cards = cards;
    if (state.view === 'cards') drawCards();
  } catch (err) {
    if (err.message !== '未登录') toast(err.message, true);
  }
}

function cardsListTable(rows) {
  return `<table class="cards-table">
    <thead><tr><th>银行</th><th>卡片</th><th>尾号</th><th>账单日</th><th>还款日</th><th>额度</th><th>操作</th></tr></thead>
    <tbody>${rows.map((c) => `
      <tr>
        <td>${esc(c.issuer) || '—'}</td>
        <td><span class="card-name-cell"><span class="dot ${esc(c.color)}"></span>${esc(c.name)}</span></td>
        <td>${esc(c.last4) || '—'}</td>
        <td>${c.billing_day ?? '—'}</td>
        <td>${esc(dueDesc(c))}</td>
        <td>${c.credit_limit_cents ? fmt(c.credit_limit_cents) : '—'}</td>
        <td class="row-actions">
          <button class="btn" data-act="edit" data-id="${c.id}">编辑</button>
          ${c.archived
            ? '<button class="btn" data-act="restore" data-id="' + c.id + '">恢复</button>'
            : '<button class="btn btn-danger" data-act="archive" data-id="' + c.id + '">归档</button>'}
        </td>
      </tr>`).join('')}</tbody>
  </table>`;
}

function drawCards() {
  const cards = state.cards || [];
  const active = cards.filter((c) => !c.archived);
  const archived = cards.filter((c) => c.archived);
  const mode = state.cardMode;

  $('#view').innerHTML = `
    <section class="panel" style="margin-top:0">
      <div class="panel-head">
        <h2>我的卡片（${active.length}）</h2>
        <div style="display:flex; gap:8px; align-items:center">
          <div class="seg">
            <button data-act="mode" data-mode="grid" class="${mode === 'grid' ? 'on' : ''}">卡片</button>
            <button data-act="mode" data-mode="list" class="${mode === 'list' ? 'on' : ''}">列表</button>
          </div>
          <button class="btn btn-primary" data-act="add">+ 添加卡片</button>
        </div>
      </div>
      ${!active.length ? '<div class="empty">还没有卡片，点击右上角「添加卡片」开始</div>'
        : mode === 'grid'
          ? `<div class="cards-grid">${active.map((c) => `
              <div class="card-cell">
                ${cardFace(c)}
                <div class="card-actions">
                  <button class="btn" data-act="edit" data-id="${c.id}">编辑</button>
                  <button class="btn btn-danger" data-act="archive" data-id="${c.id}">归档</button>
                </div>
              </div>`).join('')}</div>`
          : cardsListTable(active)}
    </section>
    ${archived.length ? `
    <section class="panel">
      <div class="panel-head"><h2>已归档（${archived.length}）</h2></div>
      ${mode === 'grid'
        ? `<div class="cards-grid">${archived.map((c) => `
            <div class="card-cell">
              ${cardFace(c)}
              <div class="card-actions">
                <button class="btn" data-act="edit" data-id="${c.id}">编辑</button>
                <button class="btn" data-act="restore" data-id="${c.id}">恢复</button>
              </div>
              <div class="archive-note">已归档 · 历史账单仍计入统计</div>
            </div>`).join('')}</div>`
        : cardsListTable(archived)}
    </section>` : ''}`;

  document.querySelectorAll('[data-act="mode"]').forEach((b) => {
    b.onclick = () => {
      state.cardMode = b.dataset.mode;
      localStorage.setItem('mycards-card-mode', state.cardMode);
      drawCards();
    };
  });
  $('[data-act="add"]').onclick = () => cardModal(null);
  document.querySelectorAll('[data-act="edit"]').forEach((b) => {
    b.onclick = () => cardModal(cards.find((c) => c.id === Number(b.dataset.id)));
  });
  document.querySelectorAll('[data-act="archive"]').forEach((b) => {
    b.onclick = () => confirmModal('归档后卡片不再出现在录入列表，历史数据保留。确定归档？', async () => {
      const r = await api(`/api/cards/${b.dataset.id}`, { method: 'DELETE' });
      const id = Number(b.dataset.id);
      state.cards = r.deleted
        ? state.cards.filter((c) => c.id !== id)
        : state.cards.map((c) => (c.id === id ? { ...c, archived: 1 } : c));
      writeSeq.cards++;
      toast(r.deleted ? '已删除' : '已归档');
      drawCards();
    });
  });
  document.querySelectorAll('[data-act="restore"]').forEach((b) => {
    b.onclick = async () => {
      const card = cards.find((c) => c.id === Number(b.dataset.id));
      try {
        const r = await api(`/api/cards/${card.id}`, { method: 'PUT', body: JSON.stringify({ ...card, credit_limit: card.credit_limit_cents / 100, archived: false }) });
        state.cards = state.cards.map((c) => (c.id === r.card.id ? r.card : c));
        writeSeq.cards++;
        toast('已恢复');
        drawCards();
      } catch (err) { toast(err.message, true); }
    };
  });
}

function cardModal(card) {
  const isEdit = !!card;
  const useOffset = isEdit && card.due_offset_days != null;
  openModal(`
    <h3>${isEdit ? '编辑卡片' : '添加卡片'}</h3>
    <div class="form-grid">
      <div class="full"><label>卡片名称 *</label><input id="f-name" maxlength="40" value="${esc(card?.name)}" placeholder="如：招行 Young 卡"></div>
      <div><label>发卡行</label><input id="f-issuer" maxlength="40" value="${esc(card?.issuer)}" placeholder="如：招商银行"></div>
      <div><label>尾号（4 位）</label><input id="f-last4" maxlength="4" inputmode="numeric" value="${esc(card?.last4)}"></div>
      <div><label>账单日（1-31）</label><input id="f-billing" type="number" min="1" max="31" value="${card?.billing_day ?? ''}"></div>
      <div><label>信用额度（元）</label><input id="f-limit" type="number" min="0" step="0.01" value="${isEdit ? toYuanInput(card.credit_limit_cents) : ''}"></div>
      <div class="full">
        <label>还款日方式</label>
        <div class="radio-row">
          <label><input type="radio" name="due-mode" value="fix" ${useOffset ? '' : 'checked'}>固定还款日</label>
          <label><input type="radio" name="due-mode" value="offset" ${useOffset ? 'checked' : ''}>账单日 + N 天</label>
        </div>
      </div>
      <div id="wrap-due-day" class="${useOffset ? 'hidden' : ''}"><label>还款日（1-31）</label><input id="f-due" type="number" min="1" max="31" value="${card?.due_day ?? ''}"></div>
      <div id="wrap-offset" class="${useOffset ? '' : 'hidden'}"><label>账单日后 N 天</label><input id="f-offset" type="number" min="1" max="31" value="${card?.due_offset_days ?? ''}"></div>
      <div><label>卡面颜色</label><select id="f-color">${COLORS.map((cl) => `<option value="${cl}" ${card?.color === cl ? 'selected' : ''}>${COLOR_NAMES[cl]}</option>`).join('')}</select></div>
      <div class="full"><label>备注</label><input id="f-note" maxlength="200" value="${esc(card?.note)}"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn btn-primary" data-act="save">保存</button>
    </div>`);

  document.querySelectorAll('input[name="due-mode"]').forEach((r) => {
    r.onchange = () => {
      const offset = $('input[name="due-mode"]:checked').value === 'offset';
      $('#wrap-due-day').classList.toggle('hidden', offset);
      $('#wrap-offset').classList.toggle('hidden', !offset);
    };
  });
  $('[data-act="cancel"]').onclick = closeModal;
  $('[data-act="save"]').onclick = async () => {
    const btn = $('[data-act="save"]');
    btn.disabled = true;
    btn.textContent = '保存中…';
    const offset = $('input[name="due-mode"]:checked').value === 'offset';
    const body = {
      name: $('#f-name').value.trim(),
      issuer: $('#f-issuer').value.trim(),
      last4: $('#f-last4').value.trim(),
      billing_day: $('#f-billing').value || null,
      due_day: offset ? null : ($('#f-due').value || null),
      due_offset_days: offset ? ($('#f-offset').value || null) : null,
      credit_limit: $('#f-limit').value || null,
      color: $('#f-color').value,
      note: $('#f-note').value.trim(),
    };
    try {
      // 保存后直接用返回的卡片更新本地缓存并重绘，不再整页重新拉取
      const r = isEdit
        ? await api(`/api/cards/${card.id}`, { method: 'PUT', body: JSON.stringify(body) })
        : await api('/api/cards', { method: 'POST', body: JSON.stringify(body) });
      state.cards = isEdit
        ? state.cards.map((c) => (c.id === r.card.id ? r.card : c))
        : [...state.cards, r.card];
      writeSeq.cards++;
      closeModal();
      toast('已保存');
      if (state.view === 'cards') drawCards();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = '保存';
    }
  };
}

/* ================= 账单录入 ================= */
function periodShift(period, delta) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function renderBills() {
  if (state.billPeriod && state.bills[state.billPeriod] && state.cards) drawBills();
  else $('#view').innerHTML = '<div class="empty">加载中…</div>';
  refreshBills();
}

async function refreshBills() {
  const period = state.billPeriod;
  const seq = writeSeq.bills;
  try {
    const [cardsRes, data] = await Promise.all([
      state.cards ? Promise.resolve({ cards: state.cards }) : api('/api/cards?archived=1'),
      // 首次进入不带 period，以服务端时区口径的当月为准（AUDIT-004）
      api(period ? `/api/bills?period=${period}` : '/api/bills'),
    ]);
    if (seq !== writeSeq.bills) return; // 刷新期间有本地写入，丢弃本次结果
    state.cards = cardsRes.cards;
    state.billPeriod = data.period; // 服务端口径优先
    state.bills[data.period] = data;
    // 正在金额输入框中打字时不重绘，避免打断输入
    const typing = document.activeElement && document.activeElement.classList.contains('amount-input');
    if (state.view === 'bills' && state.billPeriod === data.period && !typing) drawBills();
  } catch (err) {
    if (err.message !== '未登录') toast(err.message, true);
  }
}

function drawBills() {
  const period = state.billPeriod;
  const data = state.bills[period];
  if (!data) return;
  const cards = state.cards || [];
  const billsByCard = new Map(data.bills.map((b) => [b.card_id, b]));
  const today = data.today; // 服务端时区口径的「今天」（AUDIT-004）
  // 活跃卡片 + 当期有账单的归档卡片（保证归档卡的未还账单也能标记还款）
  // 按还款日升序排列，最近的排最前；无还款规则的排最后
  const dueOf = (c) => billsByCard.get(c.id)?.due_date || data.dueDates[c.id] || '9999-99-99';
  const visibleCards = cards
    .filter((c) => !c.archived || billsByCard.has(c.id))
    .sort((a, b) => dueOf(a).localeCompare(dueOf(b)));

  const rows = visibleCards.map((c) => {
    const bill = billsByCard.get(c.id);
    const due = bill?.due_date || data.dueDates[c.id];
    const dueCls = bill && !bill.paid && due ? (due < today ? 'overdue' : diffDaysLocal(due, today) <= 7 ? 'soon' : '') : '';
    return `
    <tr data-card="${c.id}">
      <td>${esc(c.issuer) || '—'}</td>
      <td><span class="card-name-cell"><span class="dot ${esc(c.color)}"></span>${esc(c.name)}${c.archived ? ' <span class="badge yellow" style="font-size:11px">已归档</span>' : ''}</span></td>
      <td><input class="amount-input" type="number" min="0" step="0.01" inputmode="decimal"
                 placeholder="—" value="${bill ? toYuanInput(bill.amount_cents) : ''}"></td>
      <td class="due-cell ${dueCls}">${due ? esc(due) : '—'}</td>
      <td class="pay-cell">${
        bill
          ? `<label><input type="checkbox" data-act="pay" ${bill.paid ? 'checked' : ''}> 已还${bill.paid ? ` <span class="paid-tag">✓</span>` : ''}</label>`
          : '<span class="muted" style="font-size:12.5px">未录入</span>'
      }</td>
    </tr>`;
  }).join('');

  $('#view').innerHTML = `
    <section class="panel" style="margin-top:0">
      <div class="panel-head">
        <div class="period-nav">
          <button class="btn" data-act="prev">‹</button>
          <div class="period-wrap">
            <button class="period-btn" id="period-btn">${esc(period.slice(0, 4))}年${Number(period.slice(5, 7))}月</button>
            <div class="period-pop hidden" id="period-pop">
              <div class="pp-row">
                <select id="pp-year" aria-label="选择年份"></select>
                <span class="muted" style="font-size:12px">选择年 · 月</span>
              </div>
              <div class="pp-grid" id="pp-grid"></div>
            </div>
          </div>
          <button class="btn" data-act="next">›</button>
        </div>
      </div>
      ${visibleCards.length ? `<table class="bills-table">
        <thead><tr><th>银行</th><th>卡片</th><th>账单金额（元）</th><th>还款日</th><th>已还</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty">请先在「卡片」页添加信用卡</div>'}
      <p class="muted" style="font-size:12.5px; margin:12px 0 0">金额输入后自动保存；清空即删除该月记录。勾选「已还」后不再提醒。</p>
    </section>`;

  $('[data-act="prev"]').onclick = () => { state.billPeriod = periodShift(period, -1); renderBills(); };
  $('[data-act="next"]').onclick = () => { state.billPeriod = periodShift(period, 1); renderBills(); };

  // 中文年月选择面板：年份下拉直接选 + 12 月格点选
  const [curY, curM] = period.split('-').map(Number);
  const todayYear = Number((data.today || '').slice(0, 4)) || curY;
  let yearOpts = '';
  for (let y = todayYear - 5; y <= todayYear + 1; y++) {
    yearOpts += `<option value="${y}" ${y === curY ? 'selected' : ''}>${y}年</option>`;
  }
  $('#pp-year').innerHTML = yearOpts;
  $('#pp-grid').innerHTML = Array.from({ length: 12 }, (_, i) =>
    `<button class="${i + 1 === curM ? 'on' : ''}" data-m="${i + 1}">${i + 1}月</button>`).join('');

  const setPeriod = (p) => { state.billPeriod = p; renderBills(); };
  $('#period-btn').onclick = () => $('#period-pop').classList.toggle('hidden');
  $('#pp-year').onchange = () => setPeriod(`${$('#pp-year').value}-${String(curM).padStart(2, '0')}`);
  document.querySelectorAll('#pp-grid button').forEach((b) => {
    b.onclick = () => setPeriod(`${$('#pp-year').value}-${String(b.dataset.m).padStart(2, '0')}`);
  });

  document.querySelectorAll('tr[data-card]').forEach((tr) => {
    const cardId = Number(tr.dataset.card);
    const input = $('.amount-input', tr);
    input.onchange = async () => {
      const raw = input.value.trim();
      if (raw !== '' && (!/^\d*\.?\d*$/.test(raw) || Number(raw) < 0)) { toast('金额无效', true); drawBills(); return; }
      try {
        const r = await api('/api/bills', {
          method: 'PUT',
          body: JSON.stringify({ card_id: cardId, period, amount: raw === '' ? null : Number(raw) }),
        });
        if (r.bill) {
          data.bills = [...data.bills.filter((b) => b.card_id !== cardId), r.bill].sort((a, b) => a.card_id - b.card_id);
        } else {
          data.bills = data.bills.filter((b) => b.card_id !== cardId);
        }
        writeSeq.bills++;
        toast(r.bill ? '已保存' : '已删除该月记录');
        drawBills();
      } catch (err) { toast(err.message, true); }
    };
    const pay = $('[data-act="pay"]', tr);
    if (pay) pay.onchange = async () => {
      const bill = billsByCard.get(cardId);
      try {
        const r = await api(`/api/bills/${bill.id}/pay`, { method: 'POST', body: JSON.stringify({ paid: pay.checked }) });
        data.bills = data.bills.map((b) => (b.id === r.bill.id ? r.bill : b));
        writeSeq.bills++;
        toast(pay.checked ? '已标记还款 🎉' : '已标记为未还');
        drawBills();
      } catch (err) { toast(err.message, true); }
    };
  });
}

function diffDaysLocal(a, b) {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}

/* ================= 统计 ================= */
function renderStats() {
  if (state.statsYear && state.stats[state.statsYear]) drawStats();
  else $('#view').innerHTML = '<div class="empty">加载中…</div>';
  refreshStats();
}

async function refreshStats() {
  const year = state.statsYear;
  try {
    // 首次进入不带 year，以服务端时区口径的当年为准（AUDIT-004）
    const s = await api(year ? `/api/stats?year=${year}` : '/api/stats');
    state.statsYear = s.year; // 服务端口径优先
    state.stats[s.year] = s;
    if (state.view === 'stats' && state.statsYear === s.year) drawStats();
  } catch (err) {
    if (err.message !== '未登录') toast(err.message, true);
  }
}

function monthDetail(s, mi) {
  const items = s.by_card.filter((c) => c.monthly[mi] > 0).sort((a, b) => b.monthly[mi] - a.monthly[mi]);
  return `
    <section class="panel">
      <div class="panel-head">
        <h2>${s.year} 年 ${mi + 1} 月明细</h2>
        <b>${fmt(s.monthly_cents[mi])}</b>
      </div>
      ${items.length
        ? `<ul class="due-list">${items.map((c) => `
            <li class="due-item">
              <span class="dot ${esc(c.color)}"></span>
              <div><b>${c.issuer ? `<span class="muted">${esc(c.issuer)} · </span>` : ''}${esc(c.name)}</b></div>
              <b>${fmt(c.monthly[mi])}</b>
            </li>`).join('')}</ul>`
        : '<div class="empty">该月暂无账单</div>'}
    </section>`;
}

function drawStats() {
  const s = state.stats[state.statsYear];
  if (!s) return;
  const max = Math.max(...s.monthly_cents, 1);
  // 当月高亮以服务端「今天」为准（AUDIT-004），仅在查看当年时高亮
  const nowMonth = s.today && s.today.slice(0, 4) === String(s.year) ? Number(s.today.slice(5, 7)) - 1 : -1;

  const bars = s.monthly_cents.map((v, i) => {
    const h = v > 0 ? Math.max((v / max) * 100, 4) : 0;
    return `
      <div class="bar-col ${i === nowMonth ? 'current' : ''} ${state.statsMonth === i ? 'selected' : ''}"
           data-month="${i}" title="${i + 1}月 ${fmt(v)} · 点击查看明细">
        <div class="bar-val">${v > 0 ? fmtShort(v) : ''}</div>
        ${h ? `<div class="bar" style="height:${h}%"></div>` : '<div style="height:2px"></div>'}
        <span>${i + 1}</span>
      </div>`;
  }).join('');

  const total = s.total_cents;
  const rows = s.by_card.map((c) => `
    <tr>
      <td><span class="card-name-cell"><span class="dot ${esc(c.color)}"></span>${c.issuer ? `<span class="muted">${esc(c.issuer)} · </span>` : ''}${esc(c.name)}</span></td>
      <td>${fmt(c.total)}</td>
      <td>${total ? Math.round((c.total / total) * 100) : 0}%</td>
      <td>${fmt(Math.round(c.total / 12))}</td>
    </tr>`).join('');

  $('#view').innerHTML = `
    <section class="panel" style="margin-top:0">
      <div class="panel-head">
        <div class="period-nav">
          <button class="btn" data-act="prev">‹</button>
          <b>${s.year} 年</b>
          <button class="btn" data-act="next">›</button>
        </div>
        <a class="btn" href="/api/export">导出备份</a>
      </div>
      <div class="chart">${bars}</div>
      <div class="chart-caption">各月账单金额（${s.year}）· 当月高亮 · 点击柱体查看当月明细</div>
      <p style="text-align:center; margin:6px 0 0">
        年度合计 <b>${fmt(total)}</b><span class="muted"> · 月均 ${fmt(Math.round(total / 12))}</span>
      </p>
    </section>
    ${state.statsMonth != null ? monthDetail(s, state.statsMonth) : ''}
    <section class="panel">
      <div class="panel-head"><h2>各卡年度合计</h2></div>
      ${s.by_card.length ? `<table class="stat-table">
        <thead><tr><th>卡片</th><th>年度合计</th><th>占比</th><th>月均</th></tr></thead>
        <tbody>${rows}<tr class="total-row"><td>合计</td><td>${fmt(total)}</td><td>100%</td><td>${fmt(Math.round(total / 12))}</td></tr></tbody>
      </table>` : `<div class="empty">${s.year} 年暂无账单数据</div>`}
    </section>`;

  document.querySelectorAll('.bar-col').forEach((el) => {
    el.onclick = () => {
      const m = Number(el.dataset.month);
      state.statsMonth = state.statsMonth === m ? null : m;
      drawStats();
    };
  });
  $('[data-act="prev"]').onclick = () => { state.statsYear--; state.statsMonth = null; renderStats(); };
  $('[data-act="next"]').onclick = () => { state.statsYear++; state.statsMonth = null; renderStats(); };
}

/* ================= 启动 ================= */
$('#login-form').addEventListener('submit', onLogin);
$('#logout').addEventListener('click', onLogout);
window.addEventListener('hashchange', route);

// 点击面板外部时收起年月选择面板
document.addEventListener('click', (e) => {
  const pop = $('#period-pop');
  if (pop && !pop.classList.contains('hidden') && !e.target.closest('.period-wrap')) {
    pop.classList.add('hidden');
  }
});

/* ================= PWA ================= */
const offlineBanner = $('#offline-banner');
function syncOfflineBanner() {
  offlineBanner.classList.toggle('hidden', navigator.onLine);
}
window.addEventListener('online', () => {
  syncOfflineBanner();
  toast('已恢复网络');
});
window.addEventListener('offline', syncOfflineBanner);
syncOfflineBanner();

// 「发现新版本」横幅：新 SW 安装完成后提示，点击后接管页面并自动刷新
function showUpdateBanner(sw) {
  const el = $('#update-banner');
  if (!el.classList.contains('hidden')) return;
  el.classList.remove('hidden');
  el.onclick = () => sw.postMessage('SKIP_WAITING');
}

let reloading = false;
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (reloading) return;
  reloading = true;
  location.reload();
});

// localhost 开发时不注册 SW，避免缓存干扰调试；updateViaCache 保证每次都拿到最新 sw.js
if (
  'serviceWorker' in navigator &&
  !['localhost', '127.0.0.1'].includes(location.hostname)
) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        // 首次安装时没有旧 SW 接管，会自动激活，无需提示
        if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(sw);
      });
    });
  }).catch(() => { /* SW 注册失败不影响正常使用 */ });
}

(async function init() {
  try {
    await api('/api/me');
    showApp();
    route();
  } catch {
    showLogin();
  }
})();
