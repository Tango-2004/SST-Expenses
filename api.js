const API_URL = 'https://script.google.com/macros/s/AKfycbzwl1HXOIIyIrBmW1-d1fNIR8q4tz-9l8B9Y1zP34784qW_a9GNOLoU_6ItLH7QpssB1A/exec';

// ===================================================
// CACHE — เก็บข้อมูลไว้ใน memory + localStorage
// ===================================================
const cache = {};
const CACHE_TTL = 60000; // 60 วิ

function cacheSet(key, data) {
  cache[key] = { data, ts: Date.now() };
  try {
    localStorage.setItem('sst_cache_' + key, JSON.stringify(cache[key]));
  } catch(_) {}
}

function cacheGet(key, maxAge = CACHE_TTL) {
  // ลอง memory ก่อน
  if (cache[key] && Date.now() - cache[key].ts < maxAge) return cache[key].data;
  // ลอง localStorage
  try {
    const raw = localStorage.getItem('sst_cache_' + key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts < maxAge * 5) { // localStorage อยู่ได้นาน 5x
        cache[key] = parsed;
        return parsed.data;
      }
    }
  } catch(_) {}
  return null;
}

// ===================================================
// CORE FETCH — timeout + retry เงียบๆ
// ===================================================
async function apiFetch(url, options = {}, retry = 0) {
  const MAX_RETRY = 3;
  const TIMEOUT = 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { throw new Error('parse_error'); }
  } catch(err) {
    clearTimeout(timer);
    if (retry < MAX_RETRY) {
      await sleep(1500 * (retry + 1));
      return apiFetch(url, options, retry + 1);
    }
    throw err;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===================================================
// API GET — ดึงข้อมูลพร้อม cache
// ===================================================
async function apiGet(action, params = {}, opts = {}) {
  const { noCache = false, silent = false } = opts;
  const cacheKey = action + JSON.stringify(params);

  // คืน cache ทันที ถ้ามี
  const cached = noCache ? null : cacheGet(cacheKey);
  if (cached) {
    // background refresh เงียบๆ
    refreshInBackground(action, params, cacheKey);
    return cached;
  }

  // ถ้าไม่มี cache และ offline — คืน stale cache แทน error
  if (!navigator.onLine) {
    const stale = cacheGet(cacheKey, Infinity);
    if (stale) return stale;
    throw new Error('ไม่มีอินเทอร์เน็ต');
  }

  if (!silent) showLoadingBar();
  const token = getToken();
  const url = buildUrl(action, params, token);

  try {
    const data = await apiFetch(url);
    if (data?.ok) {
      cacheSet(cacheKey, data);
      hideLoadingBar();
      return data;
    }
    throw new Error(data?.error || 'เกิดข้อผิดพลาด');
  } catch(err) {
    hideLoadingBar();
    // ถ้า error แต่มี stale cache — คืน cache แทน crash
    const stale = cacheGet(cacheKey, Infinity);
    if (stale && !silent) {
      showToast('แสดงข้อมูลล่าสุดที่บันทึกไว้', 'warn');
      return stale;
    }
    throw err;
  }
}

// background refresh ไม่ block UI
async function refreshInBackground(action, params, cacheKey) {
  if (!navigator.onLine) return;
  try {
    const token = getToken();
    const url = buildUrl(action, params, token);
    const data = await apiFetch(url);
    if (data?.ok) cacheSet(cacheKey, data);
  } catch(_) {}
}

// ===================================================
// API POST — ส่งข้อมูล พร้อม queue
// ===================================================
async function apiPost(action, payload = {}) {
  const token = getToken();
  const data = await apiFetch(API_URL, {
    method: 'POST',
    body: JSON.stringify({ action, payload, token }),
    headers: { 'Content-Type': 'text/plain' },
  });
  if (!data?.ok) throw new Error(data?.error || 'เกิดข้อผิดพลาด');
  // clear cache ที่เกี่ยวข้อง
  clearRelatedCache(action);
  return data;
}

function clearRelatedCache(action) {
  const clearMap = {
    submitRequest: ['getRequests', 'getLedger'],
    approveRequest: ['getRequests', 'getLedger'],
    rejectRequest: ['getRequests'],
    addLedger: ['getLedger'],
    addVehicle: ['getVehicles', 'getAlerts'],
    updateAlert: ['getAlerts', 'getVehicles'],
    createUser: ['getUsers'],
    resetPassword: ['getUsers'],
    updateUserStatus: ['getUsers'],
  };
  const keys = clearMap[action] || [];
  keys.forEach(k => {
    Object.keys(cache).forEach(ck => { if (ck.startsWith(k)) delete cache[ck]; });
    Object.keys(localStorage).forEach(lk => { if (lk.startsWith('sst_cache_' + k)) localStorage.removeItem(lk); });
  });
}

// ===================================================
// QUEUE — บันทึกหลายรายการ ไม่หลุด
// ===================================================
const queue = [];
let isSending = false;

function enqueue(action, payload, onSuccess, onError) {
  const clientId = Date.now() + '-' + Math.random().toString(36).slice(2);
  queue.push({ action, payload: { ...payload, clientId }, onSuccess, onError, clientId });
  saveQueue();
  processQueue();
}

async function processQueue() {
  if (isSending || !queue.length) return;
  isSending = true;
  const item = queue[0];
  const toast = showToast('กำลังบันทึก...', 'loading');
  try {
    const result = await apiPost(item.action, item.payload);
    queue.shift(); saveQueue();
    toast?.remove();
    showToast('บันทึกสำเร็จ ✓', 'success');
    if (item.onSuccess) item.onSuccess(result);
  } catch(err) {
    toast?.remove();
    if (!navigator.onLine) {
      showToast('จะบันทึกอัตโนมัติเมื่อมีอินเทอร์เน็ต', 'warn');
    } else {
      showToast('บันทึกไม่สำเร็จ: ' + err.message, 'error');
      if (item.onError) item.onError(err);
      queue.shift(); saveQueue();
    }
  }
  isSending = false;
  if (queue.length) setTimeout(processQueue, 800);
}

function saveQueue() {
  try { localStorage.setItem('sst_queue', JSON.stringify(queue.map(q => ({ action: q.action, payload: q.payload, clientId: q.clientId })))); }
  catch(_) {}
}

function loadQueue() {
  try {
    const saved = JSON.parse(localStorage.getItem('sst_queue') || '[]');
    saved.forEach(item => {
      if (!queue.find(q => q.clientId === item.clientId)) queue.push({ ...item, onSuccess: null, onError: null });
    });
    if (queue.length) processQueue();
  } catch(_) {}
}

window.addEventListener('online', () => {
  showToast('กลับมาออนไลน์แล้ว', 'success');
  processQueue();
});

// ===================================================
// POLLING — sync ทุก 60 วิ เงียบๆ
// ===================================================
let pollTimer = null;

function startPolling(onUpdate) {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!navigator.onLine) return;
    try {
      const data = await apiFetch(buildUrl('ping', {}, getToken()));
      if (data?.ok && onUpdate) onUpdate();
    } catch(_) {}
  }, 60000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ===================================================
// LOADING BAR — แถบด้านบนบอกว่ากำลังโหลด
// ===================================================
let loadingCount = 0;
function showLoadingBar() {
  loadingCount++;
  let bar = document.getElementById('loading-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'loading-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;height:3px;background:var(--g,#5BA85A);z-index:99999;transition:width .3s;width:0';
    document.body.appendChild(bar);
  }
  bar.style.width = '70%';
  bar.style.opacity = '1';
}

function hideLoadingBar() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount > 0) return;
  const bar = document.getElementById('loading-bar');
  if (bar) { bar.style.width = '100%'; setTimeout(() => { bar.style.opacity = '0'; bar.style.width = '0'; }, 300); }
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
    const t = showToast(`กำลังอัปโหลด ${file.name}...`, 'loading');
    try {
      const base64 = await fileToBase64(file);
      const filename = `${category}_${branch}_${now.getTime()}_${file.name}`;
      const r = await apiPost('uploadImage', { base64, filename, category, branch, year, month });
      urls.push(r.url);
      t?.remove();
      showToast(r.duplicate ? 'ไฟล์มีอยู่แล้ว' : `✓ อัปโหลดสำเร็จ`, 'success');
    } catch(err) {
      t?.remove();
      showToast(`อัปโหลด ${file.name} ล้มเหลว`, 'error');
    }
  }
  return urls;
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// ===================================================
// AUTH
// ===================================================
async function login(username, password) {
  const data = await apiFetch(buildUrl('login', { username, password }, ''));
  if (!data?.ok) throw new Error(data?.error || 'เข้าสู่ระบบไม่สำเร็จ');
  localStorage.setItem('sst_token', data.token);
  localStorage.setItem('sst_user', JSON.stringify(data.user));
  return data.user;
}

function logout() {
  // เก็บ queue ไว้ อย่าลบ
  localStorage.removeItem('sst_token');
  localStorage.removeItem('sst_user');
  // ล้าง cache
  Object.keys(localStorage).forEach(k => { if (k.startsWith('sst_cache_')) localStorage.removeItem(k); });
  stopPolling();
  window.location.reload();
}

function getToken() { return localStorage.getItem('sst_token') || ''; }
function getUser() { try { return JSON.parse(localStorage.getItem('sst_user')); } catch { return null; } }
function isAdmin() { return getUser()?.role === 'admin'; }
function hasTab(tab) { return getUser()?.tabs?.includes(tab) ?? false; }

// ===================================================
// TOAST
// ===================================================
function showToast(msg, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:300px';
    document.body.appendChild(container);
  }
  const colors = { success:'#4CAF50', error:'#E53935', warn:'#FB8C00', info:'#1976D2', loading:'#7B1FA2' };
  const el = document.createElement('div');
  el.style.cssText = `background:${colors[type]||colors.info};color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;font-weight:700;font-family:'Sarabun',sans-serif;animation:slideIn .2s ease;box-shadow:0 4px 12px rgba(0,0,0,.15)`;
  el.textContent = msg;
  container.appendChild(el);
  if (type !== 'loading') setTimeout(() => el.remove(), 3500);
  return el;
}

// ===================================================
// HELPERS
// ===================================================
function buildUrl(action, params, token) {
  const url = new URL(API_URL);
  url.searchParams.set('action', action);
  if (token) url.searchParams.set('token', token);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); });
  return url.toString();
}

// ===================================================
// INIT
// ===================================================
document.addEventListener('DOMContentLoaded', () => {
  loadQueue();
  const style = document.createElement('style');
  style.textContent = '@keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}';
  document.head.appendChild(style);
});
