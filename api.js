// api.js — SST v4 (Batch + Cache-first + Queue + Warmup)
const API_URL = 'https://script.google.com/macros/s/AKfycbzwl1HXOIIyIrBmW1-d1fNIR8q4tz-9l8B9Y1zP34784qW_a9GNOLoU_6ItLH7QpssB1A/exec';
const RETRY = 3, TIMEOUT_MS = 25000;

/* ── Memory + localStorage cache ── */
const _mem = {};
function cacheSet(k, v, ttl = 60) {
  _mem[k] = { v, exp: Date.now() + ttl * 1000 };
  try { localStorage.setItem('sst4_' + k, JSON.stringify({ v, exp: Date.now() + ttl * 10000 })); } catch (_) {}
}
function cacheGet(k) {
  if (_mem[k]?.exp > Date.now()) return _mem[k].v;
  try {
    const s = localStorage.getItem('sst4_' + k);
    if (s) { const p = JSON.parse(s); if (p.exp > Date.now()) { _mem[k] = p; return p.v; } }
  } catch (_) {}
  return null;
}

/* ── Loading bar ── */
let _bar;
function barShow() {
  if (!_bar) {
    _bar = document.createElement('div');
    _bar.style.cssText = 'position:fixed;top:0;left:0;height:3px;background:#43a047;width:0;z-index:99999;transition:width .3s,opacity .4s';
    document.body.appendChild(_bar);
  }
  _bar.style.width = '40%'; _bar.style.opacity = '1';
}
function barDone() {
  if (_bar) { _bar.style.width = '100%'; setTimeout(() => { _bar.style.opacity = '0'; _bar.style.width = '0'; }, 350); }
}

/* ── Core fetch with retry ── */
async function _fetch(url, opts = {}, attempt = 0) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(tid);
    return JSON.parse(await r.text());
  } catch (err) {
    clearTimeout(tid);
    if (attempt < RETRY - 1) { await new Promise(r => setTimeout(r, 2000)); return _fetch(url, opts, attempt + 1); }
    throw err;
  }
}

/* ── GET with cache-first ── */
async function apiGet(action, params = {}, { bust = false, ttl = 60 } = {}) {
  const token = localStorage.getItem('sst_token') || '';
  const key = action + JSON.stringify(params);
  if (!bust) {
    const cached = cacheGet(key);
    if (cached) { _bgRefresh(action, params, key, ttl, token); return cached; }
  }
  barShow();
  try {
    const qs = new URLSearchParams({ action, token, ...params }).toString();
    const data = await _fetch(API_URL + '?' + qs);
    if (data.ok !== false) cacheSet(key, data, ttl);
    barDone(); return data;
  } catch (e) {
    barDone();
    const stale = cacheGet(key);
    return stale || { ok: false, error: e.message };
  }
}

function _bgRefresh(action, params, key, ttl, token) {
  setTimeout(async () => {
    try {
      const qs = new URLSearchParams({ action, token: localStorage.getItem('sst_token') || '', ...params }).toString();
      const data = await _fetch(API_URL + '?' + qs);
      if (data.ok !== false) cacheSet(key, data, ttl);
    } catch (_) {}
  }, 200);
}

/* ── BATCH GET ── */
async function apiBatch(items = 'requests,vehicles,alerts', params = {}, { bust = false } = {}) {
  const token = localStorage.getItem('sst_token') || '';
  const key = 'batch_' + items + JSON.stringify(params);
  if (!bust) {
    const cached = cacheGet(key);
    if (cached) { _bgBatch(items, params, key, token); return cached; }
  }
  barShow();
  try {
    const qs = new URLSearchParams({ action: 'batch', token, items, ...params }).toString();
    const data = await _fetch(API_URL + '?' + qs);
    if (data.ok !== false) cacheSet(key, data, 60);
    barDone(); return data;
  } catch (e) {
    barDone();
    return cacheGet(key) || { ok: false, error: e.message };
  }
}

function _bgBatch(items, params, key, token) {
  setTimeout(async () => {
    try {
      const qs = new URLSearchParams({ action: 'batch', token: localStorage.getItem('sst_token') || '', items, ...params }).toString();
      const data = await _fetch(API_URL + '?' + qs);
      if (data.ok !== false) cacheSet(key, data, 60);
    } catch (_) {}
  }, 200);
}

/* ── POST ── */
async function apiPost(action, payload = {}) {
  const token = localStorage.getItem('sst_token') || '';
  barShow();
  try {
    const data = await _fetch(API_URL, { method: 'POST', body: JSON.stringify({ action, token, payload }) });
    barDone(); return data;
  } catch (e) { barDone(); return { ok: false, error: e.message }; }
}

/* ── Queue (offline support) ── */
const _queue = (() => { try { return JSON.parse(localStorage.getItem('sst_queue') || '[]'); } catch(_){return[];} })();
let _qRunning = false;
function enqueue(action, payload) {
  const clientId = 'cid-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  _queue.push({ action, payload: { ...payload, clientId }, clientId });
  try { localStorage.setItem('sst_queue', JSON.stringify(_queue)); } catch(_) {}
  _runQ();
  return clientId;
}
async function _runQ() {
  if (_qRunning || !_queue.length) return;
  _qRunning = true;
  while (_queue.length) {
    try {
      const r = await apiPost(_queue[0].action, _queue[0].payload);
      if (r.ok || r.duplicate) { _queue.shift(); try { localStorage.setItem('sst_queue', JSON.stringify(_queue)); } catch(_){} }
      else break;
    } catch (_) { break; }
  }
  _qRunning = false;
}
window.addEventListener('online', _runQ);

/* ── Auth ── */
async function login(username, password) {
  const data = await _fetch(API_URL + '?action=login&username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password));
  if (data.ok) {
    localStorage.setItem('sst_token', data.token);
    localStorage.setItem('sst_user', JSON.stringify(data.user));
  }
  return data;
}
function logout() {
  ['sst_token','sst_user','sst_queue'].forEach(k => localStorage.removeItem(k));
  Object.keys(localStorage).filter(k => k.startsWith('sst4_')).forEach(k => localStorage.removeItem(k));
  location.reload();
}
function getUser() { try { return JSON.parse(localStorage.getItem('sst_user')); } catch(_){ return null; } }

/* ── Polling ── */
let _pollTimer;
function startPolling(cb, ms = 60000) { stopPolling(); _pollTimer = setInterval(cb, ms); }
function stopPolling() { clearInterval(_pollTimer); }

/* ── Helpers ── */
function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
function buddhistYear() { return String(new Date().getFullYear() + 543); }
function thaiMonthName() {
  return ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
          'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'][new Date().getMonth()];
}
function fmtMoney(n) { return Number(n||0).toLocaleString('th-TH', {minimumFractionDigits:0, maximumFractionDigits:2}); }

// Warmup ping ตอนโหลด
setTimeout(async () => { try { await _fetch(API_URL + '?action=ping'); } catch(_){} }, 800);
