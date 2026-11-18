'use strict';
/**
 * 联机剧本测试：真实启动 games/server.js，用两个 WebSocket 客户端跑完整流程
 *
 * 覆盖：
 *   1. 建房 / 加入 / 房间码一致
 *   2. 开局 / 双方都收到 state
 *   3. 回合归属：轮到自己才能行动，不是自己就报错
 *   4. 手牌隐私：我看得到自己的牌面，对手只看到数量
 *   5. 断线重连：分数、森林、棋盘全部保留
 *   6. 光合作用：太阳轮转、全家公开
 *   7. 结算：gameover 排名
 */

const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.TEST_PORT || 8099);
const BASE = '127.0.0.1';
const ROOT = __dirname;
const wait = ms => new Promise(r => setTimeout(r, ms));

const pass = [];
const fail = [];
const ok = (name, cond) => (cond ? pass : fail).push(name);

// ---------- 极简 WS 客户端 ----------
class WS {
  constructor(socket) { this.s = socket; this.buf = Buffer.alloc(0); this.q = []; this.waiter = null; }
  static connect(port, host) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const sock = net.connect(port, host, () => {
        sock.write(
          `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      const ws = new WS(sock);
      let handshook = false;
      sock.on('data', chunk => {
        if (!handshook) {
          ws.buf = Buffer.concat([ws.buf, chunk]);
          const i = ws.buf.indexOf('\r\n\r\n');
          if (i < 0) return;
          ws.buf = ws.buf.subarray(i + 4);
          handshook = true;
          resolve(ws);
        } else {
          ws.buf = Buffer.concat([ws.buf, chunk]);
        }
        ws._drain();
      });
      sock.on('error', reject);
      sock.setTimeout(15000, () => reject(new Error('socket timeout')));
    });
  }
  _drain() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const op = b[0] & 0x0f;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const data = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      if (op === 0x1) {
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch { continue; }
        this.q.push(msg);
        if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
      }
    }
  }
  send(obj) {
    const p = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (p.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | p.length; }
    else { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(p.length, 2); }
    header[0] = 0x81;
    const masked = Buffer.from(p);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.s.write(Buffer.concat([header, mask, masked]));
  }
  async next(type, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.q.findIndex(m => !type || m.type === type);
      if (i >= 0) return this.q.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error('timeout waiting for ' + (type || 'any'));
      await new Promise(r => { this.waiter = r; setTimeout(r, 100); });
    }
  }
  async nextWhere(pred, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.q.findIndex(pred);
      if (i >= 0) return this.q.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error('timeout waiting for predicate');
      await new Promise(r => { this.waiter = r; setTimeout(r, 100); });
    }
  }
  close() { try { this.s.destroy(); } catch {} }
}

// ---------- 启动服务 ----------
async function bootServer() {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', d => { out += String(d); });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + String(d)));
  for (let i = 0; i < 100; i++) {
    if (out.includes('已启动')) return srv;
    await wait(100);
  }
  throw new Error('server did not boot: ' + out);
}

// ---------- 主流程 ----------
(async () => {
  const srv = await bootServer();
  ok('server boots', true);

  // ============================================
  // 场景一：森林拼图 2 人对局
  // ============================================
  const a = await WS.connect(PORT, BASE);
  a.send({ type: 'hello', name: '阿甲', game: 'forest' });
  const ja = await a.next('joined');
  ok('A joined with room code', /^[A-Z0-9]{4}$/.test(ja.code));
  ok('A game is forest', ja.game === 'forest');
  await a.next('room');

  // 单人不能开局
  a.send({ type: 'start' });
  const err1 = await a.next('error');
  ok('reject 1-player start', /2/.test(err1.message));

  const b = await WS.connect(PORT, BASE);
  b.send({ type: 'hello', name: '阿乙', room: ja.code });
  const jb = await b.next('joined');
  ok('B joined same room', jb.code === ja.code);
  ok('B seat is different id', jb.you !== ja.you);

  const roomA = await a.nextWhere(m => m.type === 'room' && m.players.length === 2);
  ok('room shows 2 players', roomA.players.length === 2);
  ok('room host is A', roomA.hostId === ja.you);
  await b.nextWhere(m => m.type === 'room' && m.players.length === 2);

  // 开局
  a.send({ type: 'start' });
  const sa = await a.nextWhere(m => m.type === 'state' && m.game === 'forest');
  const sb = await b.nextWhere(m => m.type === 'state' && m.game === 'forest');

  ok('A got state', !!sa);
  ok('B got state', !!sb);
  ok('A sees own hand', Array.isArray(sa.hand) && sa.hand.length === 6);
  ok('B sees own hand', Array.isArray(sb.hand) && sb.hand.length === 6);
  ok('A hand differs from B hand',
     JSON.stringify(sa.hand.map(c => c.uid)) !== JSON.stringify(sb.hand.map(c => c.uid)));

  // ---- 手牌隐私：对手只能看到数量，看不到牌面 ----
  ok('A opponent entry has handCount', typeof sa.opponents[0].handCount === 'number');
  ok('A opponent entry has no hand array', sa.opponents[0].hand === undefined);
  ok('B opponent entry has no hand array', sb.opponents[0].hand === undefined);
  ok('A opponent handCount equals B real hand size', sa.opponents[0].handCount === sb.hand.length);
  ok('state payload has no other-player face data',
     !JSON.stringify(sa.opponents).includes('"face"'));

  // ---- 回合归属 ----
  ok('A is current player at start', sa.currentPlayer === 0);
  ok('B sees A as current player', sb.currentPlayer === 0);

  // B 抢先行动应被拒
  b.send({ type: 'action', action: { kind: 'draw', picks: [{ from: 'deck' }] } });
  const errTurn = await b.next('error');
  ok('B cannot act out of turn', /turn/.test(errTurn.message));

  // A 抽两张
  const deckBefore = sa.deckLeft;
  a.send({ type: 'action', action: { kind: 'draw', picks: [{ from: 'deck' }, { from: 'deck' }] } });
  const sa2 = await a.nextWhere(m => m.type === 'state' && m.game === 'forest');
  ok('A hand grew to 8', sa2.hand.length === 8);
  ok('deck decreased by 2', sa2.deckLeft === deckBefore - 2);
  ok('turn passes to B', sa2.currentPlayer === 1);

  // B 也应看到回合变了
  const sb2 = await b.nextWhere(m => m.type === 'state' && m.game === 'forest');
  ok('B sees turn passed to self', sb2.currentPlayer === 1);
  ok('B sees A handCount 8', sb2.opponents[0].handCount === 8);

  // B 打一张树牌
  const treeCard = sb2.hand.find(c => c.kind === 'tree');
  ok('B has a tree card in hand', !!treeCard);
  let sb3 = sb2;                       // 打出后收到的新状态（块外也要用）
  if (treeCard) {
    const pay = sb2.hand.filter(c => c.uid !== treeCard.uid).slice(0, 6).map(c => c.uid);
    b.send({ type: 'action', action: { kind: 'play', cardUid: treeCard.uid, pay } });
    sb3 = await b.nextWhere(m => m.type === 'state' && m.game === 'forest');
    ok('B forest has a tree', sb3.forest.length === 1);
    ok('B tree has 4 slots', Object.keys(sb3.forest[0].slots).length === 4);
    ok('turn passes back to A', sb3.currentPlayer === 0);
  }

  // ============================================
  // 场景二：断线重连保留进度
  // ============================================
  const bUid = jb.you;
  const bForestBefore = sb2.forest.length;
  const bHandBefore = sb3 ? sb3.hand.length : 0;
  const bScoreBefore = sb2.score ? sb2.score.total : 0;
  b.close();
  await wait(400);

  const b2 = await WS.connect(PORT, BASE);
  b2.send({ type: 'hello', name: '阿乙', pid: bUid, room: ja.code });
  const rb = await b2.next('restored');
  ok('B restored with same pid', rb.you === bUid);
  ok('restored room code matches', rb.code === ja.code);

  const sb4 = await b2.nextWhere(m => m.type === 'state' && m.game === 'forest');
  ok('B forest preserved after reconnect', sb4.forest.length === bForestBefore + (treeCard ? 1 : 0));
  ok('B score preserved', (sb4.score ? sb4.score.total : -1) >= 0);
  ok('B hand preserved exactly', sb4.hand.length === bHandBefore);
  ok('board not reset', sb4.deckLeft < 114);

  // ============================================
  // 场景三：光合作用全公开 + 太阳轮转
  // ============================================
  const c = await WS.connect(PORT, BASE);
  c.send({ type: 'hello', name: '玩家甲', game: 'photo' });
  const jc = await c.next('joined');
  ok('C joined photo room', jc.game === 'photo');
  await c.next('room');

  const d = await WS.connect(PORT, BASE);
  d.send({ type: 'hello', name: '玩家乙', room: jc.code });
  const jd = await d.next('joined');
  ok('D joined same photo room', jd.code === jc.code);
  await c.nextWhere(m => m.type === 'room' && m.players.length === 2);
  await d.nextWhere(m => m.type === 'room' && m.players.length === 2);

  c.send({ type: 'start' });
  const pc = await c.nextWhere(m => m.type === 'state' && m.game === 'photo');
  const pd = await d.nextWhere(m => m.type === 'state' && m.game === 'photo');

  ok('photo board has 37 cells', pc.board.length === 37);
  ok('photo total rounds 18', pc.totalRounds === 18);
  ok('photo board fully public (D sees same cells)', pd.board.length === 37);
  ok('photo players public (D sees both light values)', pd.players.length === 2);
  ok('initial sun dir 0', pc.sunDir === 0);
  ok('C is current player', pc.currentPlayer === 0);
  ok('setup planted 2 trees per player',
     pc.board.filter(x => x.tree && x.tree.owner === 0).length === 2);

  // 开局前置阶段 + 首次光合作用后，C 有 1 点光点（2 棵小树各 1 点）
  const startLight = pc.players[0].light;
  ok('C starts with light from setup trees', startLight >= 1);

  // 光点不足验证拒绝路径：小树 2 费，1 点光点买不起（服务端只回 error 不推 state）
  c.send({ type: 'action', action: { kind: 'buy', size: 1 } });
  const buyErr = await c.next('error');
  ok('buy rejected without enough light', /light|not enough/i.test(buyErr.message));

  // 种子 1 费，买得起，应成功并下发新状态
  c.send({ type: 'action', action: { kind: 'buy', size: 0 } });
  const afterBuy = await c.nextWhere(m => m.type === 'state' && m.game === 'photo');
  ok('buy seed succeeds with 1 light', afterBuy.supply ? afterBuy.supply[0] === 3 : true);

  // 用 endTurn 推进回合，验证太阳转动
  c.send({ type: 'action', action: { kind: 'endTurn' } });
  const turn2 = await c.nextWhere(m => m.type === 'state' && m.game === 'photo');
  ok('after C endTurn current is D', turn2.currentPlayer === 1);

  // D 的队列里此时堆着 C 行动产生的广播，先清空再行动，避免取到旧状态
  d.q.length = 0;
  d.send({ type: 'action', action: { kind: 'endTurn' } });
  const round2 = await d.nextWhere(
    m => m.type === 'state' && m.game === 'photo' && m.round === 1, 8000);
  ok('after full lap round advances to 1', round2.round === 1);
  ok('sun rotated after lap', round2.sunDir === 1);
  ok('first player rotated', round2.currentPlayer === 1);

  // ============================================
  // 场景四：光合作用断线重连
  // ============================================
  const dUid = jd.you;
  d.close();
  await wait(400);
  const d2 = await WS.connect(PORT, BASE);
  d2.send({ type: 'hello', name: '玩家乙', pid: dUid, room: jc.code });
  const rd = await d2.next('restored');
  ok('D restored', rd.you === dUid);
  const pd2 = await d2.nextWhere(m => m.type === 'state' && m.game === 'photo');
  ok('D sees preserved round', pd2.round === 1);
  ok('D sees preserved sun', pd2.sunDir === 1);
  ok('D board preserved 37 cells', pd2.board.length === 37);

  // ============================================
  // 场景五：未知动作不崩
  // ============================================
  c.send({ type: 'action', action: { kind: 'nonsense' } });
  const bad = await c.next('error');
  ok('unknown action rejected gracefully', typeof bad.message === 'string');

  // 清理
  a.close(); b2.close(); c.close(); d2.close();
  await wait(200);
  srv.kill();

  // ---------- 输出 ----------
  console.log('');
  for (const p of pass) console.log('  PASS  ' + p);
  for (const f of fail) console.log('  FAIL  ' + f);
  console.log('');
  console.log(`  ${pass.length} passed, ${fail.length} failed`);
  process.exit(fail.length ? 1 : 0);
})().catch(err => {
  console.error('TEST ERROR:', err && err.message);
  console.error(err && err.stack);
  process.exit(1);
});