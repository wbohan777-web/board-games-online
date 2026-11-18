'use strict';
/**
 * 浏览器实机对局验证（CDP 驱动）
 * 用两个独立 profile 各起一个 Chrome，连 8091 端口，
 * 走完 建房 → 加入 → 开局 → 出牌付费 → 切换光合作用 → 太阳轮转 → 种树
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8091';
const pass = [], fail = [];
const ok = (n, c) => { (c ? pass : fail).push(n); console.log((c ? '  PASS  ' : '  FAIL  ') + n); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- CDP 客户端 ----------
class CDP {
  constructor(wsUrl) { this.url = wsUrl; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = e => rej(new Error('ws error'));
      setTimeout(() => rej(new Error('cdp timeout')), 10000);
    });
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
    return this;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('cdp call timeout: ' + method)); } }, 15000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'error';
      throw new Error('eval failed: ' + String(desc).split('\n')[0]);
    }
    return r.result && r.result.value;
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await wait(1200);
  }
  /** 等某个元素出现（最多 timeoutMs），返回是否成功 */
  async waitFor(sel, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const has = await this.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
        if (has) return true;
      } catch {}
      if (Date.now() > deadline) return false;
      await wait(200);
    }
  }
  /** 等内容满足条件（轮询），用于「元素在 DOM 但内容未更新」的场景 */
  async waitForValue(expr, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const v = await this.eval(expr);
        if (v) return v;
      } catch {}
      if (Date.now() > deadline) return false;
      await wait(250);
    }
  }
  close() { try { this.ws.close(); } catch {} }
}

async function launchChrome(port, profile, url) {
  const dir = path.join(os.tmpdir(), 'tabletop-' + profile);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });
  const p = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + dir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=480,900',
  ], { detached: true, stdio: 'ignore' });
  p.unref();

  // 等 devtools 端口就绪
  let ready = false;
  for (let i = 0; i < 80; i++) {
    await wait(250);
    try {
      await fetch('http://127.0.0.1:' + port + '/json/version').then(r => r.json());
      ready = true;
      break;
    } catch {}
  }
  if (!ready) throw new Error('devtools port not ready: ' + port);

  // 用 /json/new 显式创建标签页 —— 这样拿到的 webSocketDebuggerUrl
  // 一定是这个标签页的，不会连错到 about:blank 或旧会话恢复出来的页面
  for (let i = 0; i < 20; i++) {
    try {
      const resp = await fetch(
        'http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url),
        { method: 'PUT' }
      );
      if (!resp.ok) throw new Error('new tab HTTP ' + resp.status);
      const tab = await resp.json();
      if (!tab.webSocketDebuggerUrl) throw new Error('no ws url');
      const cdp = await new CDP(tab.webSocketDebuggerUrl).connect();
      await cdp.send('Runtime.enable').catch(() => {});
      await cdp.send('Page.enable').catch(() => {});
      cdp.targetUrl = tab.url;
      return { proc: p, cdp, port };
    } catch (e) {
      if (i === 19) throw e;
      await wait(300);
    }
  }
}

/** 导航并等到 readyState 完成，再等目标选择器出现 */
async function openAndWait(cdp, url, selector, timeoutMs = 15000) {
  await cdp.send('Page.navigate', { url });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const st = await cdp.eval(`document.readyState`);
      if (st === 'complete') {
        const has = await cdp.eval(`!!document.querySelector(${JSON.stringify(selector)})`);
        if (has) return true;
      }
    } catch {}
    if (Date.now() > deadline) return false;
    await wait(250);
  }
}

// ---------- 主流程 ----------
(async () => {
  console.log('=== 启动两个浏览器实例 ===');
  const A = await launchChrome(9222, 'a', BASE + '/');
  const B = await launchChrome(9223, 'b', BASE + '/');
  console.log('  两个实例就绪（各自独立的标签页）');

  const aReady = await openAndWait(A.cdp, BASE + '/', '#nm', 15000);
  const bReady = await openAndWait(B.cdp, BASE + '/', '#nm', 15000);
  ok('两个页面都加载出登录框', aReady && bReady);

  // ---- 建房 ----
  await A.cdp.eval(`document.getElementById('nm').value = '甲'; document.getElementById('pick-forest').click(); true`);
  await A.cdp.eval(`document.getElementById('btn-create').click(); true`);
  await A.cdp.waitFor('#room-code', 8000);
  await wait(800);
  const codeA = await A.cdp.eval(`document.getElementById('room-code').textContent`);
  ok('建房成功并显示房间码', /^[A-Z0-9]{4}$/.test(String(codeA || '')));
  console.log('  房间码 = ' + codeA);

  // ---- 加入 ----
  await openAndWait(B.cdp, BASE + '/?room=' + codeA, '#nm', 15000);
  await B.cdp.waitFor('#nm', 10000);
  await B.cdp.eval(`document.getElementById('nm').value = '乙'; true`);
  await B.cdp.eval(`document.getElementById('btn-join').click(); true`);
  await B.cdp.waitFor('#players .prow', 8000);
  await wait(800);
  const playersB = await B.cdp.eval(`document.getElementById('room-count').textContent`);
  ok('B 加入后显示 2 人', /2\s*\/\s*\d/.test(String(playersB || '')));

  // ---- 开局 ----
  await A.cdp.eval(`document.getElementById('btn-start').click(); true`);
  // 等跳到森林页并且手牌渲染出来
  const onForest = await A.cdp.waitFor('#hand .hc', 15000);
  ok('开局后进入森林页并渲染手牌', onForest);

  const urlA = await A.cdp.eval(`location.pathname`);
  ok('开局后跳到森林页', /forest\.html$/.test(String(urlA || '')));

  const handBefore = await A.cdp.eval(`document.getElementById('hand').children.length`);
  const clearBefore = await A.cdp.eval(`document.getElementById('clearing-count').textContent`);
  ok('A 看到手牌', Number(handBefore) >= 6);
  console.log('  手牌 ' + handBefore + ' 张，空地 ' + clearBefore);

  // ---- 出牌并支付（挑一张有费用的树牌，验证真实扣费） ----
  // 读引擎里的费用，选一张 cost>=1 的牌作为主牌
  // 森林开局手牌可能全是双面卡。双面卡必须挂到已有树的槽位上，
  // 而开局森林是空的，所以要先抽牌直到拿到树牌，否则一张牌都打不出去。
  for (let attempt = 0; attempt < 4; attempt++) {
    const hasTree = await A.cdp.eval(`(() => {
      const hs = [...document.getElementById('hand').children];
      return hs.some(el => el.classList.contains('tree'));
    })()`);
    if (hasTree) break;
    console.log('  手牌无树牌，抽牌重试 ' + (attempt + 1));
    await A.cdp.eval(`document.getElementById('btn-draw').click(); true`);
    await wait(1500);
    await B.cdp.eval(`document.getElementById('btn-draw').click(); true`);
    await wait(1500);
  }

  const picked = await A.cdp.eval(`(() => {
    const q = () => [...document.getElementById('hand').children];
    const readCost = el => {
      const m = (el.textContent || '').match(/费\\s*(\\d+)/);
      return m ? Number(m[1]) : 0;
    };
    // 优先选 tree 类型（不需要选槽位，出牌路径最短），退而求其次选任意有费用的牌
    let mainIdx = -1, cost = 0, isTree = false;
    const hs0 = q();
    for (let i = 0; i < hs0.length; i++) {
      const el = hs0[i];
      const c = readCost(el);
      if (c < 1) continue;
      const tree = el.classList.contains('tree');
      if (tree) { mainIdx = i; cost = c; isTree = true; break; }
      if (mainIdx < 0) { mainIdx = i; cost = c; isTree = false; }
    }
    if (mainIdx < 0) return { found: false };
    q()[mainIdx].click();
    return { found: true, mainIdx, cost, isTree };
  })()`);
  ok('找到带费用的主牌', !!(picked && picked.found));
  console.log('  主牌费用 ' + (picked && picked.cost));

  // 逐张点击支付牌：每点一次都重新查询 DOM（render 重建节点）
  const payPickResult = await A.cdp.eval(`(() => {
    const need = ${(picked && picked.cost) || 0};
    const q = () => [...document.getElementById('hand').children];
    const isPay = el => el.classList.contains('pay');
    const isSel = el => el.classList.contains('sel');
    let picked = 0;
    for (let round = 0; round < 20 && picked < need; round++) {
      const hs = q();
      let target = -1;
      for (let i = 0; i < hs.length; i++) {
        if (hs[i].classList.contains('sel')) continue;
        if (isPay(hs[i])) continue;
        target = i; break;
      }
      if (target < 0) break;
      q()[target].click();
      picked = q().filter(isPay).length;
    }
    return { picked, need };
  })()`);
  console.log('  支付牌选中 ' + payPickResult.picked + '/' + payPickResult.need);

  await wait(400);
  const paySel = await A.cdp.eval(`document.querySelectorAll('#hand .hc.pay').length`);
  ok('支付牌可被选中（修复后应 > 0）', Number(paySel) > 0);
  ok('支付牌数量等于主牌费用', Number(paySel) === (picked && picked.cost));
  console.log('  已选支付牌 ' + paySel + ' 张');

  const handCountBeforeConfirm = await A.cdp.eval(`document.getElementById('hand').children.length`);
  const clearCountBefore = await A.cdp.eval(`document.querySelectorAll('#clearing .cc').length`);
  const mainCost = (picked && picked.cost) || 0;

  await A.cdp.eval(`document.getElementById('btn-confirm').click(); true`);
  await wait(2500);

  // 调试：抓实际发出的 pay 与服务端返回的错误提示
  const dbg = await A.cdp.eval(`(() => {
    const t = document.getElementById('toast');
    return JSON.stringify({
      toast: t ? t.textContent : null,
      dbg: (typeof window.__dbg === 'function') ? window.__dbg() : null,
    });
  })()`);
  console.log('  调试 ' + dbg);

  const handAfter = await A.cdp.eval(`document.getElementById('hand').children.length`);
  const clearCountAfter = await A.cdp.eval(`document.querySelectorAll('#clearing .cc').length`);
  // 手牌减少量 = 1 张主牌 + cost 张支付牌
  const expectedDrop = 1 + mainCost;
  const actualDrop = Number(handCountBeforeConfirm) - Number(handAfter);
  ok('出牌后手牌按费用减少', actualDrop === expectedDrop);
  ok('支付牌进入空地', Number(clearCountAfter) > Number(clearCountBefore));
  console.log('  手牌 ' + handCountBeforeConfirm + ' → ' + handAfter +
              '（应减 ' + expectedDrop + '，实减 ' + actualDrop + '）' +
              '，空地 ' + clearCountBefore + ' → ' + clearCountAfter);

  // ---- 光合作用：用全新浏览器实例，彻底避开森林段的会话污染 ----
  const C = await launchChrome(9224, 'c', BASE + '/');
  const D = await launchChrome(9225, 'd', BASE + '/');
  const cReady = await openAndWait(C.cdp, BASE + '/', '#nm', 15000);
  const dReady = await openAndWait(D.cdp, BASE + '/', '#nm', 15000);
  ok('光合两个页面加载出登录框', cReady && dReady);

  await C.cdp.eval(`document.getElementById('nm').value = '丙'; document.getElementById('pick-photo').click(); true`);
  await C.cdp.eval(`document.getElementById('btn-create').click(); true`);
  // 等 room-code 变成 4 位真码（元素一直存在，所以必须轮询内容）
  const codeP = await C.cdp.waitForValue(
    `(() => { const v = document.getElementById('room-code').textContent; return /^[A-Z0-9]{4}$/.test(v) ? v : false; })()`,
    15000);
  ok('光合房间创建', typeof codeP === 'string' && /^[A-Z0-9]{4}$/.test(codeP));
  console.log('  光合房间码 = ' + codeP);

  await openAndWait(D.cdp, BASE + '/?room=' + codeP, '#nm', 15000);
  await D.cdp.eval(`document.getElementById('nm').value = '丁'; true`);
  await D.cdp.eval(`document.getElementById('btn-join').click(); true`);
  await D.cdp.waitFor('#players .prow', 10000);
  await wait(800);

  await C.cdp.eval(`document.getElementById('btn-start').click(); true`);
  const photoReady = await C.cdp.waitFor('#board', 20000);
  ok('开局后进入光合页', photoReady);
  await D.cdp.waitFor('#board', 20000);

  const urlP = await C.cdp.eval(`location.pathname`);
  ok('开局后跳到光合页', /photo\.html$/.test(String(urlP || '')));
  await wait(1500);

  const sun0 = await C.cdp.eval(`document.getElementById('sunlabel').textContent`);
  const round0 = await C.cdp.eval(`document.getElementById('round').textContent`);
  ok('太阳方位已显示', /太阳/.test(String(sun0 || '')));
  console.log('  初始 ' + sun0 + '，回合 ' + round0);

  const cells = await C.cdp.eval(`(() => { const c = document.getElementById('board'); return c ? c.width + 'x' + c.height : 'none'; })()`);
  ok('六角棋盘画布已渲染', /^\d+x\d+$/.test(String(cells || '')) && !/^0x/.test(String(cells)));
  console.log('  画布尺寸 ' + cells);

  // 注意：买种子/种树必须在「当前玩家是自己」时做，所以放在回合轮转之前。
  // 先买种子、种树，最后再各结束一次回合验证太阳轮转。

  // ---- 种树验证：买种子 → 选中自己的树 → 点相邻空格 → 棋盘出现种子 ----
  const dbg0 = await C.cdp.waitForValue(
    `(() => { const d = window.__dbgPhoto && window.__dbgPhoto(); return d && d.myTrees.length ? JSON.stringify(d) : false; })()`,
    10000);
  const state0 = dbg0 ? JSON.parse(dbg0) : null;
  ok('开局每人已有 2 棵小树', !!(state0 && state0.myTrees.length === 2));
  ok('开局光点 > 0（否则买不起种子）', !!(state0 && state0.light > 0));
  console.log('  开局光点 ' + (state0 && state0.light) + '，我的树 ' +
              (state0 && state0.myTrees.length) + ' 棵');

  // 买种子（尺寸 0）
  await C.cdp.eval(`(() => {
    const btns = [...document.querySelectorAll('.sbtn')];
    const seed = btns.find(b => (b.textContent || '').includes('种子'));
    if (seed) seed.click();
    return true;
  })()`);
  await wait(1500);
  const dbg1 = JSON.parse(await C.cdp.eval(`JSON.stringify(window.__dbgPhoto())`));
  ok('买种子后库存减少', dbg1.supply[0] === (state0.supply[0] - 1));
  ok('买种子后光点减少', dbg1.light < state0.light);
  console.log('  种子库存 ' + state0.supply[0] + ' → ' + dbg1.supply[0] +
              '，光点 ' + state0.light + ' → ' + dbg1.light);

  // 选中自己的树，再点相邻空格种下
  const plantResult = await C.cdp.eval(`(() => {
    const st = window.__S.state;
    const cv = document.getElementById('board');
    const rect = cv.getBoundingClientRect();
    const w = cv.clientWidth, h = cv.clientHeight;
    const size = Math.min(w, h) / 7.4;
    const ox = w / 2, oy = h / 2;
    const at = (q, r) => ({
      x: rect.left + size * Math.sqrt(3) * (q + r / 2) + ox,
      y: rect.top + size * 1.5 * r + oy,
    });
    const myIdx = st.you;
    const mine = st.board.find(c => c.tree && c.tree.owner === myIdx);
    if (!mine) return { ok: false, reason: 'no own tree' };
    // 找相邻空格
    const dirs = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
    let target = null;
    for (const [dq, dr] of dirs) {
      const c = st.board.find(x => x.q === mine.q + dq && x.r === mine.r + dr);
      if (c && !c.tree) { target = c; break; }
    }
    if (!target) return { ok: false, reason: 'no empty neighbour' };
    const a = at(mine.q, mine.r);
    const b = at(target.q, target.r);
    cv.dispatchEvent(new MouseEvent('click', { clientX: a.x, clientY: a.y, bubbles: true }));
    cv.dispatchEvent(new MouseEvent('click', { clientX: b.x, clientY: b.y, bubbles: true }));
    return { ok: true, from: { q: mine.q, r: mine.r }, to: { q: target.q, r: target.r } };
  })()`);
  ok('找到可种的相邻空格', !!(plantResult && plantResult.ok));
  if (plantResult && plantResult.ok) {
    console.log('  从 (' + plantResult.from.q + ',' + plantResult.from.r + ') 种到 ('
                + plantResult.to.q + ',' + plantResult.to.r + ')');
  }

  await wait(2000);
  const dbg2 = JSON.parse(await C.cdp.eval(`JSON.stringify(window.__dbgPhoto())`));
  const seedAtTarget = dbg2.trees.find(t =>
    plantResult && plantResult.ok &&
    t.q === plantResult.to.q && t.r === plantResult.to.r &&
    t.owner === dbg2.you && t.size === 0);
  ok('棋盘上出现了种子', !!seedAtTarget);
  ok('种子库存再减 1', dbg2.supply[0] === (dbg1.supply[0] - 1));
  console.log('  棋盘上的树 ' + dbg2.trees.length + ' 棵，种子库存 ' + dbg2.supply[0]);

  // ---- 太阳轮转：两边各结束一次回合，一圈走完太阳转一格 ----
  await C.cdp.eval(`document.getElementById('btn-end').click(); true`);
  await wait(1800);
  await D.cdp.eval(`document.getElementById('btn-end').click(); true`);
  await wait(2500);

  const sun1 = await C.cdp.eval(`document.getElementById('sunlabel').textContent`);
  const round1 = await C.cdp.eval(`document.getElementById('round').textContent`);
  ok('一圈后太阳转动', String(sun1) !== String(sun0));
  ok('一圈后回合推进', Number(round1) > Number(round0));
  console.log('  转后 ' + sun1 + '，回合 ' + round1);

  // ---- 奖励效果正向触发：注入花旗松 + 两张带花旗松叶子的支付牌 ----
  // 花旗松（douglasFir）2 费，bonus = Extrazug。
  // 原版规则：支付牌全部带匹配叶子符号时，额外回合才生效。
  const E = await launchChrome(9226, 'e', BASE + '/');
  const F = await launchChrome(9227, 'f', BASE + '/');
  await openAndWait(E.cdp, BASE + '/', '#nm', 15000);
  await openAndWait(F.cdp, BASE + '/', '#nm', 15000);

  await E.cdp.eval(`document.getElementById('nm').value = '戊'; document.getElementById('pick-forest').click(); true`);
  await E.cdp.eval(`document.getElementById('btn-create').click(); true`);
  const codeE = await E.cdp.waitForValue(
    `(() => { const v = document.getElementById('room-code').textContent; return /^[A-Z0-9]{4}$/.test(v) ? v : false; })()`,
    15000);
  ok('奖励用例房间创建', typeof codeE === 'string' && /^[A-Z0-9]{4}$/.test(codeE));
  console.log('  奖励用例房间码 = ' + codeE);

  await openAndWait(F.cdp, BASE + '/?room=' + codeE, '#nm', 15000);
  await F.cdp.eval(`document.getElementById('nm').value = '己'; true`);
  await F.cdp.eval(`document.getElementById('btn-join').click(); true`);
  await F.cdp.waitFor('#players .prow', 10000);
  await wait(800);

  await E.cdp.eval(`document.getElementById('btn-start').click(); true`);
  await E.cdp.waitFor('#hand .hc', 15000);
  await wait(1200);

  // 注册结果监听，捕获服务端回传的 bonusFired / extraTurn
  await E.cdp.eval(`window.__lastActionResult = null;
    App.on('action_result', m => { window.__lastActionResult = m; }); true`);

  // 注入确定性手牌（clear=true 清空原手牌，避免选到叶子符号不匹配的牌作支付）
  const injected = await E.cdp.eval(`App.send({
    type: 'debug_inject',
    clear: true,
    cards: [
      { kind: 'tree', face: 'douglasFir', leaf: 'douglasFir' },
      { kind: 'split', a: 'europeanHare', aTree: 'douglasFir', b: 'europeanBadger', bTree: 'oak' },
      { kind: 'split', a: 'redDeer', aTree: 'douglasFir', b: 'wolf', bTree: 'beech' }
    ]
  })`);
  ok('注入确定性手牌', injected === true);
  await wait(1800);

  const handAfterInject = await E.cdp.eval(`document.getElementById('hand').children.length`);
  ok('注入后手牌只有 3 张', Number(handAfterInject) === 3);
  console.log('  注入后手牌 ' + handAfterInject + ' 张');

  // 点花旗松为主牌，再点两张带花旗松叶子的牌作支付，最后确认
  const bonusPlay = await E.cdp.eval(`(() => {
    const q = () => [...document.getElementById('hand').children];
    const hs = q();
    let mainIdx = -1;
    for (let i = 0; i < hs.length; i++) {
      if ((hs[i].textContent || '').includes('花旗松')) { mainIdx = i; break; }
    }
    if (mainIdx < 0) return { ok: false, reason: 'no douglasFir in hand' };
    q()[mainIdx].click();
    // 逐张点支付：每点一次 DOM 会重建，所以每轮重新查询
    for (let round = 0; round < 10; round++) {
      const cur = q();
      if (cur.filter(e => e.classList.contains('pay')).length >= 2) break;
      let t = -1;
      for (let i = 0; i < cur.length; i++) {
        if (cur[i].classList.contains('sel')) continue;
        if (cur[i].classList.contains('pay')) continue;
        t = i; break;
      }
      if (t < 0) break;
      q()[t].click();
    }
    return { ok: true, payCount: q().filter(e => e.classList.contains('pay')).length };
  })()`);
  ok('花旗松可作为主牌并选满 2 张支付', !!(bonusPlay && bonusPlay.ok && bonusPlay.payCount === 2));

  const turnBefore = await E.cdp.eval(`window.__S.state.currentPlayer`);
  const youBefore = await E.cdp.eval(`window.__S.state.you`);

  await E.cdp.eval(`document.getElementById('btn-confirm').click(); true`);
  await wait(2500);

  const ar = await E.cdp.eval(`JSON.stringify(window.__lastActionResult)`);
  const arObj = ar ? JSON.parse(ar) : null;
  ok('服务端回传 action_result', !!arObj);
  ok('bonusFired 为 true', !!(arObj && arObj.bonusFired === true));
  ok('bonusEffect 是 Extrazug', !!(arObj && /Extrazug/.test(String(arObj.bonusEffect || ''))));
  ok('extraTurn 为 true', !!(arObj && arObj.extraTurn === true));
  console.log('  奖励结果 ' + ar);

  const turnAfter = await E.cdp.eval(`window.__S.state.currentPlayer`);
  ok('额外回合后 currentPlayer 仍是自己', Number(turnAfter) === Number(youBefore));
  console.log('  回合归属 ' + turnBefore + ' → ' + turnAfter + '（自己 = ' + youBefore + '）');

  // ---- 收尾 ----
  for (const c of [A, B, C, D]) { try { c.cdp.close(); } catch {} }
  for (const c of [A, B, C, D]) { try { process.kill(c.proc.pid); } catch {} }

  console.log('');
  console.log(`  ${pass.length} passed, ${fail.length} failed`);
  process.exit(fail.length ? 1 : 0);
})().catch(e => {
  console.error('TEST ERROR:', e.message);
  process.exit(1);
});