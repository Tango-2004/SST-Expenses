const API_URL = 'https://script.google.com/macros/s/AKfycbzwl1HXOIIyIrBmW1-d1fNIR8q4tz-9l8B9Y1zP34784qW_a9GNOLoU_6ItLH7QpssB1A/exec';

// ===================================================
// CACHE
// ===================================================
const _cache = {};
function cacheSet(k, d) {
  _cache[k] = { d, t: Date.now() };
  try { localStorage.setItem('c_' + k, JSON.stringify(_cache[k])); } catch(_) {}
}
function cacheGet(k, ttl = 60000) {
  if (_cache[k] && Date.now() - _cache[k].t < ttl) return _cache[k].d;
  try {
    const s = localStorage.getItem('c_' + k);
    if (s) { const p = JSON.parse(s); if (Date.now() - p.t < ttl * 10) { _cache[k] = p; return p.d; } }
  } catch(_) {}
  return null;
}
function cacheClear(...keys) {
  keys.forEach(k => {
    Object.keys(_cache).forEach(ck => { if (ck.startsWith(k)) delete _cache[ck]; });
    Object.keys(localStorage).forEach(lk => { if (lk.startsWith('c_' + k)) localStorage.removeItem(lk); });
  });
}

// ===================================================
// FETCH with timeout + retry
// ===================================================
async function _fetch(url, opts = {}, retry = 0) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    const txt = await r.text();
    try { return JSON.parse(txt); } catch { throw new Error('ข้อมูลไม่ถูกต้อง'); }
  } catch(e) {
    clearTimeout(t);
    if (retry < 3 && navigator.onLine) {
      await new Promise(r => setTimeout(r, 2000 * (retry + 1)));
      return _fetch(url, opts, retry + 1);
    }
    throw e.name === 'AbortError' ? new Error('เชื่อมต่อช้า กำลังลองใหม่...') : e;
  }
}

// ===================================================
// API GET — cache first
// ===================================================
async function apiGet(action, params = {}, noCache = false) {
  const key = action + JSON.stringify(params);
  const cached = noCache ? null : cacheGet(key);
  if (cached) {
    // refresh เงียบๆ
    _fetch(buildUrl(action, params)).then(d => { if (d?.ok) cacheSet(key, d); }).catch(() => {});
    return cached;
  }
  if (!navigator.onLine) {
    const stale = cacheGet(key, Infinity);
    if (stale) return stale;
    throw new Error('ไม่มีอินเทอร์เน็ต');
  }
  bar(1);
  try {
    const d = await _fetch(buildUrl(action, params));
    bar(0);
    if (!d?.ok) throw new Error(d?.error || 'เกิดข้อผิดพลาด');
    cacheSet(key, d);
    return d;
  } catch(e) {
    bar(0);
    const stale = cacheGet(key, Infinity);
    if (stale) { showToast('แสดงข้อมูลเก่า (ไม่มีสัญญาณ)', 'warn'); return stale; }
    throw e;
  }
}

// ===================================================
// API POST
// ===================================================
async function apiPost(action, payload = {}) {
  const d = await _fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify({ action, payload, token: getToken() }),
    headers: { 'Content-Type': 'text/plain' },
  });
  if (!d?.ok) throw new Error(d?.error || 'เกิดข้อผิดพลาด');
  const clearMap = {
    submitRequest: ['getRequests'], approveRequest: ['getRequests','getLedger'],
    rejectRequest: ['getRequests'], addLedger: ['getLedger'],
    addVehicle: ['getVehicles','getAlerts'], updateAlert: ['getAlerts','getVehicles'],
    createUser: ['getUsers'], resetPassword: ['getUsers'], updateUserStatus: ['getUsers'],
  };
  if (clearMap[action]) cacheClear(...clearMap[action]);
  return d;
}

// ===================================================
// QUEUE
// ===================================================
const _q = [];
let _sending = false;
function enqueue(action, payload, onOk, onErr) {
  const id = Date.now() + '-' + Math.random().toString(36).slice(2);
  _q.push({ action, payload: { ...payload, clientId: id }, onOk, onErr, id });
  _saveQ();
  _runQ();
}
async function _runQ() {
  if (_sending || !_q.length) return;
  _sending = true;
  const item = _q[0];
  const t = showToast('กำลังบันทึก...', 'loading');
  try {
    const r = await apiPost(item.action, item.payload);
    _q.shift(); _saveQ(); t?.remove();
    showToast('✓ บันทึกสำเร็จ', 'success');
    item.onOk?.(r);
  } catch(e) {
    t?.remove();
    if (!navigator.onLine) { showToast('จะบันทึกเมื่อมีอินเทอร์เน็ต', 'warn'); }
    else { _q.shift(); _saveQ(); showToast('❌ ' + e.message, 'error'); item.onErr?.(e); }
  }
  _sending = false;
  if (_q.length) setTimeout(_runQ, 800);
}
function _saveQ() { try { localStorage.setItem('sst_q', JSON.stringify(_q.map(q => ({ action: q.action, payload: q.payload, id: q.id })))); } catch(_) {} }
function loadQueue() {
  try {
    const saved = JSON.parse(localStorage.getItem('sst_q') || '[]');
    saved.forEach(i => { if (!_q.find(q => q.id === i.id)) _q.push({ ...i, onOk: null, onErr: null }); });
    if (_q.length) _runQ();
  } catch(_) {}
}
window.addEventListener('online', () => { showToast('กลับมาออนไลน์', 'success'); _runQ(); });

// ===================================================
// POLLING — เงียบๆ ทุก 60 วิ
// ===================================================
let _poll = null;
function startPolling(cb) {
  stopPolling();
  _poll = setInterval(() => { if (navigator.onLine && cb) cb(); }, 60000);
}
function stopPolling() { if (_poll) { clearInterval(_poll); _poll = null; } }

// ===================================================
// LOADING BAR
// ===================================================
let _barCount = 0;
function bar(show) {
  _barCount = Math.max(0, _barCount + (show ? 1 : -1));
  let el = document.getElementById('_bar');
  if (!el) {
    el = document.createElement('div');
    el.id = '_bar';
    el.style.cssText = 'position:fixed;top:0;left:0;height:3px;background:#5BA85A;z-index:99999;transition:width .4s,opacity .3s;width:0;opacity:0';
    document.body.appendChild(el);
  }
  if (_barCount > 0) { el.style.opacity = '1'; el.style.width = '70%'; }
  else { el.style.width = '100%'; setTimeout(() => { el.style.opacity = '0'; el.style.width = '0'; }, 400); }
}

// ===================================================
// IMAGE UPLOAD
// ===================================================
async function uploadImages(files, category, branch) {
  const now = new Date();
  const year = String(now.getFullYear() + 543);
  const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  const month = months[now.getMonth()];
  const urls = [];
  for (const file of files) {
    const t = showToast(`อัปโหลด ${file.name}...`, 'loading');
    try {
      const base64 = await fileToBase64(file);
      const r = await apiPost('uploadImage', { base64, filename: `${category}_${branch}_${Date.now()}_${file.name}`, category, branch, year, month });
      urls.push(r.url); t?.remove(); showToast('✓ อัปโหลดสำเร็จ', 'success');
    } catch(e) { t?.remove(); showToast('อัปโหลดล้มเหลว: ' + e.message, 'error'); }
  }
  return urls;
}
function fileToBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(file); });
}

// ===================================================
// AUTH
// ===================================================
async function login(user, pass) {
  const d = await _fetch(buildUrl('login', { username: user, password: pass }));
  if (!d?.ok) throw new Error(d?.error || 'เข้าสู่ระบบไม่สำเร็จ');
  localStorage.setItem('sst_token', d.token);
  localStorage.setItem('sst_user', JSON.stringify(d.user));
  return d.user;
}
function logout() {
  ['sst_token','sst_user'].forEach(k => localStorage.removeItem(k));
  Object.keys(localStorage).forEach(k => { if (k.startsWith('c_')) localStorage.removeItem(k); });
  stopPolling(); window.location.reload();
}
function getToken() { return localStorage.getItem('sst_token') || ''; }
function getUser() { try { return JSON.parse(localStorage.getItem('sst_user')); } catch { return null; } }
function isAdmin() { return getUser()?.role === 'admin'; }
function hasTab(t) { return getUser()?.tabs?.includes(t) ?? false; }

// ===================================================
// TOAST
// ===================================================
function showToast(msg, type = 'info') {
  let c = document.getElementById('_toasts');
  if (!c) {
    c = document.createElement('div');
    c.id = '_toasts';
    c.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:300px';
    document.body.appendChild(c);
  }
  const colors = { success:'#388E3C', error:'#D32F2F', warn:'#F57C00', info:'#1565C0', loading:'#6A1B9A' };
  const el = document.createElement('div');
  el.style.cssText = `background:${colors[type]||colors.info};color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;font-weight:700;font-family:'Sarabun',sans-serif;animation:_si .2s ease;box-shadow:0 4px 12px rgba(0,0,0,.2)`;
  el.textContent = msg;
  c.appendChild(el);
  if (type !== 'loading') setTimeout(() => el.remove(), 3500);
  return el;
}

// ===================================================
// HELPERS
// ===================================================
function buildUrl(action, params = {}) {
  const u = new URL(API_URL);
  u.searchParams.set('action', action);
  u.searchParams.set('token', getToken());
  Object.entries(params).forEach(([k, v]) => { if (v != null) u.searchParams.set(k, String(v)); });
  return u.toString();
}

document.addEventListener('DOMContentLoaded', () => {
  loadQueue();
  const s = document.createElement('style');
  s.textContent = '@keyframes _si{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}';
  document.head.appendChild(s);
});
