'use strict';
/**
 * 共享前端逻辑：WebSocket 连接、消息分发、DOM 工具
 * 两个游戏页面与大厅共用
 */

const App = (() => {
  let ws = null;
  let handlers = new Map();
  let reconnectTimer = 0;
  let session = { pid: '', code: '', game: '', name: '' };
  let closedByUser = false;

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  let toastTimer = 0;
  function toast(msg, ms = 1800) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------- 会话持久化 ----------
  function loadSession() {
    try {
      const raw = sessionStorage.getItem('tableSession');
      if (raw) session = Object.assign(session, JSON.parse(raw));
    } catch {}
    return session;
  }
  function saveSession() {
    try { sessionStorage.setItem('tableSession', JSON.stringify(session)); } catch {}
  }
  function clearSession() {
    session = { pid: '', code: '', game: '', name: '' };
    try { sessionStorage.removeItem('tableSession'); } catch {}
  }

  // ---------- 连接 ----------
  function url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host;
  }

  function connect() {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === 1) return resolve(ws);
      let settled = false;
      const done = (ok, err) => {
        if (settled) return;
        settled = true;
        ok ? resolve(ws) : reject(err || new Error('ws failed'));
      };
      let sock;
      try { sock = new WebSocket(url()); } catch (e) { return reject(e); }
      ws = sock;
      const guard = setTimeout(() => done(false, new Error('连接超时')), 8000);

      sock.onopen = () => { clearTimeout(guard); done(true); };
      sock.onerror = () => { clearTimeout(guard); done(false, new Error('连接失败')); };
      sock.onclose = () => {
        clearTimeout(guard);
        done(false, new Error('连接已关闭'));
        if (!closedByUser && session.code) {
          toast('连接断开，正在重连…');
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            const token = localStorage.getItem('token');
            connect().then(() => {
              send({ type: 'hello', token, pid: session.pid, room: session.code });
            }).catch(() => {});
          }, 2500);
        }
      };
      sock.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        dispatch(msg);
      };
    });
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  function on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(fn);
  }

  function dispatch(msg) {
    const list = handlers.get(msg.type) || [];
    for (const fn of list) { try { fn(msg); } catch (e) { console.error(e); } }
    const any = handlers.get('*') || [];
    for (const fn of any) { try { fn(msg); } catch (e) { console.error(e); } }
  }

  // ---------- 通用消息处理 ----------
  on('joined', m => {
    session.pid = m.you;
    session.code = m.code;
    session.game = m.game;
    saveSession();
  });
  on('restored', m => {
    session.pid = m.you;
    session.code = m.code;
    session.game = m.game;
    saveSession();
    toast('已回到原房间');
  });
  on('error', m => toast(m.message || '出错了'));

  // ---------- 心跳 ----------
  setInterval(() => {
    if (ws && ws.readyState === 1) send({ type: 'ping', t: Date.now() });
  }, 15000);

  // ---------- 入口：建房或加入 ----------
  async function enter({ game, room, token, isPublic }) {
    closedByUser = false;
    await connect();
    if (room) {
      send({ type: 'hello', token, pid: session.pid, room: String(room).toUpperCase() });
    } else {
      clearSession();
      saveSession();
      send({ type: 'hello', token, game, isPublic });
    }
  }

  function inviteLink(code) {
    return location.origin + location.pathname.replace(/[^/]*$/, '') + '?room=' + encodeURIComponent(code);
  }

  async function copyText(txt) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(txt);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }

  function leave() {
    closedByUser = true;
    clearSession();
    if (ws) { try { ws.close(); } catch {} }
    location.reload();
  }

  return {
    $, esc, el, toast, connect, send, on, dispatch,
    loadSession, saveSession, clearSession,
    enter, inviteLink, copyText, leave,
    get session() { return session; },
    get socket() { return ws; },
  };
})();