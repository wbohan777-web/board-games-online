'use strict';
/**
 * 双桌游联机服务端
 * 零依赖：node:http + 自实现 RFC6455 WebSocket
 * 挂载两套游戏：forest（森林拼图）、photo（光合作用）
 *
 * 协议：
 *   C→S  {type:'hello', name, room?, pid?, game?}
 *         {type:'start'}
 *         {type:'action', action:{...}}
 *         {type:'again'}
 *         {type:'ping', t}
 *   S→C  {type:'joined'|'restored', you, code, game}
 *         {type:'room', code, game, phase, players[], host}
 *         {type:'state', ...游戏状态快照（每人裁剪）}
 *         {type:'error', message}
 *         {type:'gameover', ranking[]}
 *         {type:'pong', t}
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const forest = require('./forest-shuffle/engine.js');
const photo = require('./photosynthesis/engine.js');

const GAMES = {
  forest: { name: '森林拼图', engine: forest, min: 2, max: 5 },
  photo: { name: '光合作用', engine: photo, min: 2, max: 4 },
};

const COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#a855f7'];

// ---------- 工具 ----------
const randInt = n => crypto.randomInt(n);
const roomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[randInt(chars.length)];
  return s;
};

// ---------- 房间 ----------
const rooms = new Map();
const connections = new Map(); // 管理所有 WebSocket 连接

function createRoom(host, gameId, fixedCode, isPublic = true) {
  let code = String(fixedCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (code.length < 4 || rooms.has(code)) {
    do { code = roomCode(); } while (rooms.has(code));
  }
  const room = {
    code,
    game: gameId,
    hostId: host.id,
    players: new Map(),
    phase: 'lobby',        // lobby | playing | finished
    state: null,           // 游戏引擎状态
    createdAt: Date.now(),
    isPublic,              // 是否在公开大厅显示
  };
  room.players.set(host.id, host);
  rooms.set(code, room);
  
  // 如果是公开房间，广播大厅更新
  if (isPublic) {
    broadcastLobby();
  }
  
  return room;
}

// 获取公开房间列表
function getLobbyRooms() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.isPublic && room.phase !== 'finished') {
      list.push({
        code: room.code,
        game: room.game,
        gameName: GAMES[room.game].name,
        hostName: [...room.players.values()].find(p => p.id === room.hostId)?.name || '未知',
        playerCount: room.players.size,
        maxPlayers: GAMES[room.game].max,
        phase: room.phase,
        createdAt: room.createdAt,
      });
    }
  }
  // 按创建时间倒序排序（最新的在前）
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

// 向所有在大厅的客户端广播房间列表
function broadcastLobby() {
  const lobbyData = { type: 'lobby', rooms: getLobbyRooms() };
  const payload = JSON.stringify(lobbyData);
  
  // 遍历所有连接，向没有加入房间的客户端发送
  for (const conn of connections.values()) {
    if (conn.ws && !conn.room) {
      try {
        sendFrame(conn.ws, 1, Buffer.from(payload, 'utf8'));
      } catch (e) {
        // 忽略发送错误
      }
    }
  }
}

function playerList(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    colorIdx: p.colorIdx,
    color: COLORS[p.colorIdx % COLORS.length],
    connected: !!p.ws,
    isHost: p.id === room.hostId,
  }));
}

function roomMsg(room) {
  return {
    type: 'room',
    code: room.code,
    game: room.game,
    gameName: GAMES[room.game].name,
    phase: room.phase,
    hostId: room.hostId,
    max: GAMES[room.game].max,
    players: playerList(room),
  };
}

// ---------- WebSocket（RFC6455 子集） ----------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsAccept = key => crypto.createHash('sha1').update(key + GUID).digest('base64');

function sendFrame(socket, opcode, payload) {
  if (!socket || socket.destroyed) return;
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  try { socket.write(Buffer.concat([header, payload])); } catch {}
}
const sendText = (socket, text) => sendFrame(socket, 0x1, Buffer.from(text, 'utf8'));

function decodeFrames(state, chunk, onMessage, onClose) {
  state.buf = Buffer.concat([state.buf, chunk]);
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return;
    const mask = masked ? b.subarray(off, off + 4) : null;
    off += maskLen;
    const data = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    state.buf = b.subarray(off + len);

    if (opcode === 0x8) { onClose(); return; }
    if (opcode === 0x9) { sendFrame(state.socket, 0xA, data); continue; }
    if (opcode === 0xA) continue;
    if (opcode === 0x1 || opcode === 0x0) {
      state.frag = state.frag ? Buffer.concat([state.frag, data]) : data;
      if (fin) {
        const text = state.frag.toString('utf8');
        state.frag = null;
        onMessage(text);
      }
    }
    if (state.buf.length === 0) return;
  }
}

// ---------- 广播 ----------
function broadcast(room, payload) {
  const text = JSON.stringify(payload);
  for (const p of room.players.values()) if (p.ws) sendText(p.ws, text);
}
function sendTo(p, payload) { if (p && p.ws) sendText(p.ws, JSON.stringify(payload)); }

function pushRoom(room) { broadcast(room, roomMsg(room)); }

/**
 * 下发游戏状态。森林拼图需要裁剪：只给自己看手牌，
 * 别人的手牌数量单独给。光合作用全公开。
 */
function pushState(room) {
  if (!room.state) return;
  if (room.game === 'forest') {
    const st = room.state;
    const base = {
      type: 'state',
      game: 'forest',
      phase: room.phase,
      deckLeft: st.deck.length,
      clearing: st.clearing.map(c => ({ uid: c.uid, kind: c.kind, face: describeCard(c) })),
      winterRevealed: st.winterRevealed,
      ended: st.ended,
    };
    for (const p of room.players.values()) {
      const gi = p.gameIndex;
      const me = st.players[gi];
      if (!me) continue;
      const view = {
        ...base,
        you: gi,
        // 费用必须由服务端下发：前端不要自己猜，否则显示的费和实际扣费会不一致
        hand: me.hand.map(c => ({
          uid: c.uid,
          kind: c.kind,
          face: faceOf(c),
          cost: costOfCard(st, c),
          leaf: c.kind === 'split' ? [c.leafA, c.leafB] : (c.leaf || null),
        })),
        forest: me.forest.map(t => ({
          uid: t.uid,
          treeId: t.treeId,
          slots: t.slots,
        })),
        cave: me.cave.length,
        score: forest.scorePlayer(st, gi),
        opponents: st.players.filter((_, i) => i !== gi).map(o => ({
          index: o.index,
          name: o.name,
          handCount: o.hand.length,
          forest: o.forest.map(t => ({ uid: t.uid, treeId: t.treeId, slots: t.slots })),
          cave: o.cave.length,
          score: 0,
        })),
        currentPlayer: st.currentPlayer,
        turn: st.turn,
        // 保留回合模式与免费放置额度：前端据此显示「继续出牌 / 免费放置」界面
        turnMode: st.turnMode || null,
        pendingFree: st.pendingFree ? {
          kind: st.pendingFree.kind,
          types: st.pendingFree.types || [],
          names: st.pendingFree.names || [],
          options: st.pendingFree.options || [],
          remaining: st.pendingFree.remaining,
        } : null,
      };
      sendTo(p, view);
    }
  } else {
    // 光合作用：棋盘与所有玩家公开，但每人要收到自己的 you 索引
    const st = room.state;
    const base = {
      type: 'state',
      game: 'photo',
      phase: room.phase,
      sunDir: st.sunDir,
      round: st.round,
      totalRounds: st.totalRounds,
      currentPlayer: st.currentPlayer,
      firstPlayer: st.firstPlayer,
      ended: st.ended,
      board: st.board.map(c => ({
        q: c.q, r: c.r, leaves: c.leaves,
        tree: c.tree ? { owner: c.tree.owner, size: c.tree.size } : null,
      })),
      players: st.players.map((p, i) => ({
        index: i,
        name: p.name,
        light: p.light,
        supply: p.supply,
        tokens: p.tokens,
        score: p.tokens.reduce((a, b) => a + b, 0),
      })),
    };
    for (const p of room.players.values()) {
      sendTo(p, { ...base, you: p.gameIndex });
    }
  }
}

/** 从引擎的效果索引取真实费用（spec.json 的 cards[].cost） */
function costOfCard(st, c) {
  if (!st || !st.effectById) return 0;
  if (c.kind === 'tree') {
    const e = st.effectById.get(c.face);
    return e && e.cost != null ? Number(e.cost) : 0;
  }
  if (c.kind === 'split') {
    // 双面卡两面费用相同（同一张实体牌），取 a 面
    const e = st.effectById.get(c.faces[0].id);
    return e && e.cost != null ? Number(e.cost) : 0;
  }
  return 0;
}

function describeCard(c) {  if (c.kind === 'winter') return { kind: 'winter' };
  if (c.kind === 'tree') return { kind: 'tree', id: c.face };
  return { kind: 'split', faces: c.faces.map(f => f.id) };
}
function faceOf(c) {
  if (c.kind === 'winter') return { kind: 'winter' };
  if (c.kind === 'tree') return { kind: 'tree', id: c.face };
  return { kind: 'split', faces: c.faces.map(f => ({ id: f.id, tree: f.tree })) };
}

// ---------- 动作分发 ----------
function applyAction(room, p, action) {
  if (!room.state || room.phase !== 'playing') return { ok: false, error: 'not playing' };
  const gi = p.gameIndex;

  if (room.game === 'forest') {
    const st = room.state;
    if (st.currentPlayer !== gi) return { ok: false, error: 'not your turn' };
    const engine = forest;

    if (action.kind === 'draw') {
      const r = engine.actionDraw(st, gi, action.picks || []);
      if (r.ok) { st.turn++; st.currentPlayer = (gi + 1) % st.players.length; }
      return r;
    }
    if (action.kind === 'play') {
      const r = engine.actionPlay(st, gi, action);
      if (r.ok) {
        st.turn++;
        const prevMode = st.turnMode;
        // 额外回合（狼、熊等 Extrazug）：回合仍归自己
        if (r.extraTurn) {
          st.extraTurns = (st.extraTurns || 0) + 1;
        } else if (r.keepTurn) {
          // 本次出牌开启保留回合（水鼠任意树苗 / 鼹鼠付费连打）
          st.keepTurns = (st.keepTurns || 0) + 1;
          st.turnMode = r.mode || 'keep';
        } else if (prevMode === 'anyPaid') {
          // 鼹鼠模式：可任意付费连打，回合不交
        } else if (prevMode === 'saplings' && action.asTree) {
          // 水鼠模式：本回合内继续放树苗，回合不交
        } else if (st.pendingFree) {
          // 打出牌触发了「免费放置」额度：回合先压住，结算完再交出
          st.turnMode = 'pending';
        } else {
          st.currentPlayer = (gi + 1) % st.players.length;
          st.turnMode = null;
        }
      }
      return r;
    }
    if (action.kind === 'play_free') {
      // 免费放置：不付费、不触发该牌效果与奖励
      const r = engine.actionPlayFree(st, gi, action);
      if (r.ok) {
        st.freePlays = (st.freePlays || 0) + 1;
        // 额度用尽 → 这张牌的结算完成，交出回合（保留回合模式除外）
        if (!st.pendingFree && st.turnMode === 'pending') {
          st.currentPlayer = (gi + 1) % st.players.length;
          st.turnMode = null;
        }
      }
      return r;
    }
    if (action.kind === 'take_clearing') {
      // 从空地取指定类型的牌入手（LichtungHandTyp 结算）
      const r = engine.actionTakeClearing(st, gi, action.uid);
      if (r.ok) {
        st.clearingPicks = (st.clearingPicks || 0) + 1;
        if (!st.pendingFree && st.turnMode === 'pending') {
          st.currentPlayer = (gi + 1) % st.players.length;
          st.turnMode = null;
        }
      }
      return r;
    }
    if (action.kind === 'endTurn') {
      // 保留回合模式下由玩家主动收手
      st.currentPlayer = (gi + 1) % st.players.length;
      st.turnMode = null;
      st.pendingFree = null;
      return { ok: true, ended: false };
    }
    return { ok: false, error: 'unknown action' };
  }

  // 光合作用
  const st = room.state;
  if (st.currentPlayer !== gi) return { ok: false, error: 'not your turn' };
  const engine = photo;
  let r;
  switch (action.kind) {
    case 'buy': r = engine.buy(st, gi, action.size); break;
    case 'plant': r = engine.plantSeed(st, gi, action.fromQ, action.fromR, action.toQ, action.toR); break;
    case 'grow': r = engine.growTree(st, gi, action.q, action.r); break;
    case 'collect': r = engine.collectToken(st, gi, action.q, action.r, action.value); break;
    case 'endTurn': r = { ok: true }; break;
    default: r = { ok: false, error: 'unknown action' };
  }
  if (r.ok && action.kind === 'endTurn') {
    st.currentPlayer = (gi + 1) % st.players.length;
    // 一圈结束则推进回合（太阳转动）
    if (st.currentPlayer === st.firstPlayer) {
      const nr = engine.nextRound(st);
      if (nr.ended) { finishGame(room); return { ok: true, ended: true }; }
    }
  }
  return r;
}

function finishGame(room) {
  room.phase = 'finished';
  let ranking;
  if (room.game === 'forest') {
    ranking = room.state.players.map((p, i) => {
      const sc = forest.scorePlayer(room.state, i);
      return { index: i, name: p.name, score: sc.total, detail: sc.detail, rank: 0 };
    }).sort((a, b) => b.score - a.score).map((x, i) => ({ ...x, rank: i + 1 }));
  } else {
    ranking = photo.finalScore(room.state).map((x, i) => ({ ...x, rank: i + 1 }));
  }
  broadcast(room, { type: 'gameover', game: room.game, ranking });
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^([/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, games: Object.keys(GAMES) }));
    return;
  }
  serveStatic(req, res);
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const st = { socket, buf: Buffer.alloc(0), frag: null };
  const conn = { socket, room: null, player: null, ws: socket };
  const connId = crypto.randomUUID();
  connections.set(connId, conn);

  const onClose = () => {
    connections.delete(connId);
    const p = conn.player, room = conn.room;
    if (p && room && p.ws === conn.socket) {
      p.ws = null;
      p.disconnectedAt = Date.now();
      pushRoom(room);
      // 玩家离开，广播大厅更新
      if (room.isPublic) broadcastLobby();
    }
    try { socket.destroy(); } catch {}
  };

  socket.on('data', c => {
    try { decodeFrames(st, c, text => {
      let msg; try { msg = JSON.parse(text); } catch { return; }
      handle(conn, msg);
    }, onClose); } catch { onClose(); }
  });
  socket.on('error', onClose);
  socket.on('close', onClose);
});

// ---------- 消息处理 ----------
function handle(conn, msg) {
  const t = msg && msg.type;

  // 获取大厅房间列表
  if (t === 'getLobby') {
    const lobbyData = { type: 'lobby', rooms: getLobbyRooms() };
    sendTo({ ws: conn.socket }, lobbyData);
    return;
  }

  if (t === 'hello') {
    const name = String(msg.name || '').trim().slice(0, 14) || ('玩家' + (1000 + randInt(9000)));
    const wanted = String(msg.room || '').trim().toUpperCase();
    const pid = String(msg.pid || '');

    // 会话恢复
    if (pid && wanted && rooms.has(wanted)) {
      const room = rooms.get(wanted);
      const old = room.players.get(pid);
      if (old) {
        old.name = name;
        old.ws = conn.socket;
        old.disconnectedAt = 0;
        conn.player = old;
        conn.room = room;
        sendTo(old, { type: 'restored', you: old.id, code: room.code, game: room.game });
        pushRoom(room);
        if (room.state) pushState(room);
        return;
      }
    }

    const gameId = GAMES[msg.game] ? msg.game : 'forest';
    const player = {
      id: crypto.randomUUID(),
      name,
      colorIdx: 0,
      ws: conn.socket,
      gameIndex: -1,
      disconnectedAt: 0,
    };
    conn.player = player;

    if (wanted && rooms.has(wanted)) {
      const room = rooms.get(wanted);
      if (room.players.size >= GAMES[room.game].max) {
        sendTo(player, { type: 'error', message: '房间已满' });
        return;
      }
      if (room.phase !== 'lobby') {
        sendTo(player, { type: 'error', message: '本局已开始，等下一局' });
        return;
      }
      player.colorIdx = room.players.size;
      room.players.set(player.id, player);
      conn.room = room;
      sendTo(player, { type: 'joined', you: player.id, code: room.code, game: room.game });
      pushRoom(room);
      // 房间人数变化，广播大厅更新
      if (room.isPublic) broadcastLobby();
      return;
    }

    // 建房（支持 isPublic 参数，默认公开）
    player.colorIdx = 0;
    const isPublic = msg.isPublic !== false; // 默认 true
    const room = createRoom(player, gameId, msg.code, isPublic);
    conn.room = room;
    sendTo(player, { type: 'joined', you: player.id, code: room.code, game: room.game });
    pushRoom(room);
    return;
  }

  if (!conn.room || !conn.player) return;
  const room = conn.room;
  const p = conn.player;

  if (t === 'start') {
    if (p.id !== room.hostId) return;
    if (room.phase === 'playing') return;
    const n = room.players.size;
    if (n < GAMES[room.game].min) {
      sendTo(p, { type: 'error', message: `至少 ${GAMES[room.game].min} 人才能开局` });
      return;
    }
    // 分配游戏内索引（按入座顺序）
    let i = 0;
    for (const pl of room.players.values()) pl.gameIndex = i++;

    try {
      if (room.game === 'forest') {
        room.state = forest.createGame({
          players: [...room.players.values()].sort((a, b) => a.gameIndex - b.gameIndex).map(x => x.name),
          seed: randInt(1e9),
        });
      } else {
        room.state = photo.createGame({
          players: [...room.players.values()].sort((a, b) => a.gameIndex - b.gameIndex).map(x => x.name),
          seed: randInt(1e9),
        });
        // 开局立即执行一次光合作用阶段：第一回合太阳不转，但树要收光点。
        // 不跑这一步，所有人开局 0 光点，买不起种子，种树链路直接死锁。
        photo.photosynthesisPhase(room.state);
      }
    } catch (e) {
      sendTo(p, { type: 'error', message: '开局失败: ' + e.message });
      return;
    }
    room.phase = 'playing';
    pushRoom(room);
    pushState(room);
    // 游戏开始，房间状态变化，广播大厅更新
    if (room.isPublic) broadcastLobby();
    return;
  }

  if (t === 'action') {
    const r = applyAction(room, p, msg.action || {});
    if (!r.ok) { sendTo(p, { type: 'error', message: r.error }); return; }
    // 把出牌结果（含奖励效果是否触发、是否额外回合）回传给本人，供界面提示与测试断言
    if (r.bonusFired !== undefined || r.extraTurn !== undefined || r.effect) {
      sendTo(p, {
        type: 'action_result',
        action: msg.action && msg.action.kind,
        bonusFired: !!r.bonusFired,
        bonusEffect: r.bonusEffect || null,
        extraTurn: !!r.extraTurn,
        keepTurn: !!r.keepTurn,
        mode: r.mode || null,
        // pending 必须下发，否则免费放置/空地取牌类效果在联机里等于不存在
        pending: (r.effect && r.effect.pending) || [],
        paidLeaf: r.paidLeaf || null,
        playedFaceId: r.playedFaceId || null,
        log: (r.effect && r.effect.log) || [],
      });
    }
    if (room.phase === 'playing') pushState(room);
    return;
  }

  if (t === 'debug_inject') {
    // 仅测试用：把指定牌直接塞进手牌，用于构造确定性场景（如奖励效果正向触发）。
    // 必须显式设置 TEST_MODE=1 才生效，正式部署不会有这条路径。
    if (process.env.TEST_MODE !== '1') return;
    if (!room.state || room.phase !== 'playing') return;
    const gi = p.gameIndex;
    const st = room.state;
    const me = st.players[gi];
    if (!me) return;
    // clear: 先清空手牌，让注入的牌成为唯一可选，便于构造确定性场景
    if (msg.clear) me.hand.length = 0;
    let uid = 900000 + Math.floor(Math.random() * 90000);
    for (const spec of (msg.cards || [])) {
      if (!spec || !spec.kind) continue;
      if (spec.kind === 'tree') {
        me.hand.push({ uid: uid++, kind: 'tree', face: spec.face, leaf: spec.leaf || spec.face, hidden: null });
      } else if (spec.kind === 'split') {
        me.hand.push({
          uid: uid++, kind: 'split',
          faces: [
            { id: spec.a, tree: spec.aTree },
            { id: spec.b, tree: spec.bTree },
          ],
          leafA: spec.aTree, leafB: spec.bTree,
          orient: 'h', face: null, hidden: null,
        });
      }
    }
    pushState(room);
    return;
  }

  if (t === 'again') {
    if (p.id !== room.hostId) return;
    if (room.phase === 'playing') return;
    room.phase = 'lobby';
    room.state = null;
    for (const pl of room.players.values()) pl.gameIndex = -1;
    pushRoom(room);
    return;
  }

  if (t === 'ping') {
    sendTo(p, { type: 'pong', t: msg.t || 0 });
    return;
  }
}

// ---------- 清理 ----------
setInterval(() => {
  const ts = Date.now();
  for (const [code, room] of rooms) {
    if (room.phase === 'lobby') {
      for (const [pid, p] of room.players) {
        if (!p.ws && p.disconnectedAt && ts - p.disconnectedAt > 60000) room.players.delete(pid);
      }
    }
    const live = [...room.players.values()].filter(x => x.ws).length;
    if (live === 0 && room.phase === 'lobby' && ts - room.createdAt > 5 * 60000) {
      rooms.delete(code);
    }
  }
}, 15000);

// ---------- 启动 ----------
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
    console.log('双桌游联机服务已启动');
    console.log('  游戏: ' + Object.entries(GAMES).map(([k, v]) => `${v.name}(${k})`).join(' / '));
    console.log('  本机: http://127.0.0.1:%d', PORT);
    for (const ip of ips) console.log('  局域网: http://%s:%d', ip, PORT);
  });
}

// ---------- 房间自动清理 ----------
setInterval(() => {
  const now = Date.now();
  const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 分钟无活动
  const EMPTY_TIMEOUT = 5 * 60 * 1000;  // 5 分钟无人
  
  for (const [code, room] of rooms.entries()) {
    let shouldDelete = false;
    let reason = '';
    
    // 房间已结束且超过 5 分钟
    if (room.phase === 'finished' && (now - room.createdAt) > EMPTY_TIMEOUT) {
      shouldDelete = true;
      reason = '已结束';
    }
    
    // 房间无人且超过 5 分钟
    if (room.players.size === 0 && (now - room.createdAt) > EMPTY_TIMEOUT) {
      shouldDelete = true;
      reason = '无人';
    }
    
    // 所有玩家都掉线超过 30 分钟
    const allDisconnected = [...room.players.values()].every(p => 
      !p.ws && p.disconnectedAt && (now - p.disconnectedAt) > IDLE_TIMEOUT
    );
    if (allDisconnected && room.players.size > 0) {
      shouldDelete = true;
      reason = '全员掉线超时';
    }
    
    if (shouldDelete) {
      console.log(`[清理] 删除房间 ${code} (${reason}, ${room.players.size}人)`);
      rooms.delete(code);
      if (room.isPublic) {
        broadcastLobby();
      }
    }
  }
}, 5 * 60 * 1000); // 每5分钟执行一次

module.exports = { server, rooms, GAMES, applyAction, createRoom, finishGame };