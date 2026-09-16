const API_URL = 'https://script.google.com/macros/s/AKfycbzVM4-1hAcCZTz6DTvSiUzmG7jteTxrQ_oc4njzSn3q9ONY769H1VmBVC8ajUNVWc8IgA/exec';

// Queue สำหรับส่งข้อมูลทีละชุด ไม่หลุด
const queue = [];
let isSending = false;

// ===================================================
// CORE API CALL
// ===================================================
async function apiGet(action, params = {}) {
  const token = localStorage.getItem('sst_token');
  const url = new URL(API_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('token', token || '');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString());
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data;
}

async function apiPost(action, payload = {}) {
  const token = localStorage.getItem('sst_token');
  const res = await fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify({ action, payload, token }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data;
}

// ===================================================
// QUEUE SYSTEM — บันทึกหลายรายการไม่หลุด
// ===================================================
function enqueue(action, payload, onSuccess, onError) {
  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  queue.push({ action, payload: { ...payload, clientId }, onSuccess, onError, clientId });
  savePendingQueue();
  processQueue();
}

async function processQueue() {
  if (isSending || queue.length === 0) return;
  isSending = true;

  const item = queue[0];
  try {
    showToast('กำลังบันทึก...', 'loading');
    const result = await apiPost(item.action, item.payload);
    queue.shift();
    savePendingQueue();
    showToast('บันทึกสำเร็จ', 'success');
    if (item.onSuccess) item.onSuccess(result);
  } catch (err) {
    // ถ้า network ขาด เก็บไว้ใน localStorage แล้วลองใหม่
    if (!navigator.onLine) {
      showToast('ไม่มีอินเทอร์เน็ต — จะบันทึกอัตโนมัติเมื่อออนไลน์', 'warn');
    } else {
      showToast(`เกิดข้อผิดพลาด: ${err.message}`, 'error');
      if (item.onError) item.onError(err);
      queue.shift(); // ข้ามรายการที่ error จริงๆ
      savePendingQueue();
    }
  }

  isSending = false;
  if (queue.length > 0) setTimeout(processQueue, 500);
}

// retry เมื่อกลับมาออนไลน์
window.addEventListener('online', () => {
  showToast('กลับมาออนไลน์แล้ว — กำลังบันทึกรายการค้างอยู่', 'info');
  processQueue();
});

function savePendingQueue() {
  localStorage.setItem('sst_queue', JSON.stringify(queue.map(q => ({
    action: q.action, payload: q.payload, clientId: q.clientId
  }))));
}

function loadPendingQueue() {
  const saved = localStorage.getItem('sst_queue');
  if (!saved) return;
  const items = JSON.parse(saved);
  items.forEach(item => {
    if (!queue.find(q => q.clientId === item.clientId)) {
      queue.push({ ...item, onSuccess: null, onError: null });
    }
  });
  if (queue.length > 0) processQueue();
}

// ===================================================
// IMAGE UPLOAD — อัปโหลดรูปขึ้น Drive
// ===================================================
async function uploadImages(files, category, branch) {
  const now = new Date();
  const year = `${now.getFullYear() + 543}`;
  const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  const month = months[now.getMonth()];
  const urls = [];

  for (const file of files) {
    const base64 = await fileToBase64(file);
    const filename = `${category}_${branch}_${now.getTime()}_${file.name}`;
    showToast(`กำลังอัปโหลด ${file.name}...`, 'loading');
    try {
      const result = await apiPost('uploadImage', {
        base64, filename, category, branch, year, month
      });
      urls.push(result.url);
      showToast(result.duplicate ? `${file.name} มีอยู่แล้ว` : `อัปโหลด ${file.name} สำเร็จ`, 'success');
    } catch (err) {
      showToast(`อัปโหลด ${file.name} ล้มเหลว`, 'error');
    }
  }

  return urls;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ===================================================
// REAL-TIME POLLING — sync ทุก 30 วิ
// ===================================================
let pollingInterval = null;
let lastTs = 0;

function startPolling(onUpdate) {
  if (pollingInterval) return;
  pollingInterval = setInterval(async () => {
    try {
      const result = await apiGet('ping');
      if (result.ts > lastTs) {
        lastTs = result.ts;
        if (onUpdate) onUpdate();
      }
    } catch (_) {}
  }, 30000);
}

function stopPolling() {
  clearInterval(pollingInterval);
  pollingInterval = null;
}

// ===================================================
// AUTH
// ===================================================
async function login(username, password) {
  const res = await apiGet('login', { username, password });
  localStorage.setItem('sst_token', res.token);
  localStorage.setItem('sst_user', JSON.stringify(res.user));
  return res.user;
}

function logout() {
  localStorage.removeItem('sst_token');
  localStorage.removeItem('sst_user');
  stopPolling();
  window.location.reload();
}

function getUser() {
  const u = localStorage.getItem('sst_user');
  return u ? JSON.parse(u) : null;
}

function isAdmin() {
  return getUser()?.role === 'admin';
}

function hasTab(tab) {
  return getUser()?.tabs?.includes(tab) ?? false;
}

// ===================================================
// TOAST NOTIFICATION
// ===================================================
function showToast(msg, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px';
    document.body.appendChild(container);
  }

  const colors = {
    success: '#4CAF50', error: '#E53935', warn: '#FB8C00',
    info: '#1976D2', loading: '#7B1FA2'
  };

  const toast = document.createElement('div');
  toast.style.cssText = `background:${colors[type]||colors.info};color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;font-family:'Sarabun',sans-serif;max-width:280px;animation:slideIn .2s ease`;
  toast.textContent = msg;
  container.appendChild(toast);

  if (type !== 'loading') {
    setTimeout(() => toast.remove(), 3000);
  }

  return toast;
}

// ===================================================
// INIT
// ===================================================
document.addEventListener('DOMContentLoaded', () => {
  loadPendingQueue();
  const style = document.createElement('style');
  style.textContent = `@keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}`;
  document.head.appendChild(style);
});
