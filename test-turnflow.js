'use strict';
/**
 * 回合流转与选择流断言：
 *   1. keepTurn（水鼠任意树苗 / 鼹鼠付费连打）在服务端不推进回合
 *   2. EinsKostenlosAblegen 系列下发 pending 并能被 play_free 结算
 *   3. LichtungHandTyp 下发 pending 并能被 take_clearing 结算
 *   4. 真实计分牌打到冬卡终局，得分非零
 */
const path = require('path');
const S = require(path.join(__dirname, 'server.js'));
const forest = require(path.join(__dirname, 'forest-shuffle', 'engine.js'));

const pass = [], fail = [];
const ok = (n, c) => (c ? pass : fail).push(n);
const eq = (n, a, b) => ok(n + '（' + a + ' === ' + b + '）', a === b);

function mkRoom(seed) {
  const host = { id: 'p1', name: '甲', colorIdx: 0, gameIndex: 0, ws: null };
  const room = S.createRoom(host, 'forest');
  room.players.set('p2', { id: 'p2', name: '乙', colorIdx: 1, gameIndex: 1, ws: null });
  room.state = forest.createGame({ players: ['甲', '乙'], seed });
  room.phase = 'playing';
  return room;
}
const P1 = r => r.players.get('p1');
const P2 = r => r.players.get('p2');

// 注入指定牌到手牌（确定性构造）
function inject(st, gi, cards) {
  st.players[gi].hand.length = 0;
  let uid = 700000 + gi * 1000;
  for (const s of cards) {
    if (s.kind === 'tree') {
      st.players[gi].hand.push({ uid: uid++, kind: 'tree', face: s.face, leaf: s.leaf || s.face, hidden: null });
    } else {
      st.players[gi].hand.push({
        uid: uid++, kind: 'split',
        faces: [{ id: s.a, tree: s.aTree }, { id: s.b, tree: s.bTree }],
        leafA: s.aTree, leafB: s.bTree, orient: 'h', face: null, hidden: null,
      });
    }
  }
}

/** 构造场景时把某张牌的费用临时置零，专注验证流转而非支付 */
function freeCost(st, faceId) {
  const e = st.effectById.get(faceId);
  if (e) { e.cost = 0; }
  return st;
}

/** 预置一棵主植物：双面卡必须挂到已有树的槽位上 */
function plantTree(st, gi, treeId) {
  const uid = 600000 + gi * 100 + st.players[gi].forest.length;
  st.players[gi].forest.push({
    uid, treeId,
    slots: { top: null, bottom: null, left: null, right: null },
  });
  return uid;
}

// ---------- 1. keepTurn：水鼠（BeliebigSprösslingeAusspielen） ----------
{
  const room = mkRoom(7);
  const st = room.state;
  inject(st, 0, [
    { kind: 'split', a: 'waterVole', aTree: 'birch', b: 'x', bTree: 'birch' },
    { kind: 'tree', face: 'birch', leaf: 'birch' },
    { kind: 'tree', face: 'oak', leaf: 'oak' },
  ]);
  freeCost(st, 'waterVole');
  const t1 = plantTree(st, 0, 'birch');
  const before = st.currentPlayer;
  const r = S.applyAction(room, P1(room), {
    kind: 'play', cardUid: st.players[0].hand[0].uid, pay: [],
    treeUid: t1, slot: 'top', face: 0,
  });
  ok('水鼠可打出（0 费）', r.ok === true);
  ok('水鼠返回 keepTurn', r.keepTurn === true);
  eq('水鼠模式为 saplings', r.mode, 'saplings');
  eq('水鼠保留回合：currentPlayer 不变', st.currentPlayer, before);
  eq('服务端记录 turnMode', st.turnMode, 'saplings');

  // 保留回合中再出一张牌，仍归自己
  const r2 = S.applyAction(room, P1(room), {
    kind: 'play', cardUid: st.players[0].hand[0].uid, pay: [], asTree: true,
  });
  ok('保留回合中可继续出牌', r2.ok === true);
  eq('连续出牌后仍轮到自己', st.currentPlayer, before);

  // 手动收手
  const r3 = S.applyAction(room, P1(room), { kind: 'endTurn' });
  ok('endTurn 成功', r3.ok === true);
  eq('收手后轮到对手', st.currentPlayer, 1);
  eq('收手后清除 turnMode', st.turnMode, null);
}

// ---------- 2. keepTurn：鼹鼠（BeliebigKartenKostenpflichtigSpielen） ----------
{
  const room = mkRoom(11);
  const st = room.state;
  inject(st, 0, [
    { kind: 'split', a: 'mole', aTree: 'birch', b: 'x', bTree: 'birch' },
    { kind: 'tree', face: 'birch', leaf: 'birch' },
    { kind: 'tree', face: 'oak', leaf: 'oak' },
    { kind: 'tree', face: 'beech', leaf: 'beech' },
  ]);
  freeCost(st, 'mole');
  const t2 = plantTree(st, 0, 'birch');
  const before = st.currentPlayer;
  const r = S.applyAction(room, P1(room), {
    kind: 'play', cardUid: st.players[0].hand[0].uid, pay: [],
    treeUid: t2, slot: 'top', face: 0,
  });
  ok('鼹鼠可打出', r.ok === true);
  ok('鼹鼠返回 keepTurn', r.keepTurn === true);
  eq('鼹鼠模式为 anyPaid', r.mode, 'anyPaid');
  eq('鼹鼠保留回合', st.currentPlayer, before);
}

// ---------- 3. pending：EinsKostenlosAblegen(Pflanze) → play_free ----------
{
  const room = mkRoom(13);
  const st = room.state;
  // capercaillie 的 immediate 是 EinsKostenlosAblegen(Pflanze)
  inject(st, 0, [
    { kind: 'split', a: 'capercaillie', aTree: 'birch', b: 'x', bTree: 'birch' },
    { kind: 'split', a: 'treeFerns', aTree: 'oak', b: 'y', bTree: 'oak' },   // plant 类型，可免费放
    { kind: 'tree', face: 'beech', leaf: 'beech' },
  ]);
  freeCost(st, 'capercaillie');
  const t3 = plantTree(st, 0, 'birch');
  const r = S.applyAction(room, P1(room), {
    kind: 'play', cardUid: st.players[0].hand[0].uid, pay: [],
    treeUid: t3, slot: 'top', face: 0,
  });
  ok('松鸡可打出', r.ok === true);
  eq('下发 pending 条目数', (r.effect.pending || []).length, 1);
  eq('pending 类型为 freePlayOne', r.effect.pending[0].kind, 'freePlayOne');
  ok('额度已落到 pendingFree', !!st.pendingFree);
  eq('额度类型为 plant', st.pendingFree.types[0], 'plant');
  eq('额度剩余 1 次', st.pendingFree.remaining, 1);

  // 用一张非植物牌尝试免费放置 → 应被拒
  const treeCard = st.players[0].hand.find(c => c.kind === 'tree');
  const bad = S.applyAction(room, P1(room), { kind: 'play_free', cardUid: treeCard.uid, asTree: true });
  eq('类型不符时免费放置被拒', bad.ok, false);

  // 用植物牌免费放置 → 成功且不扣费
  const plantCard = st.players[0].hand.find(c =>
    c.kind === 'split' && (c.faces[0].id === 'treeFerns' || c.faces[1].id === 'treeFerns'));
  const forestBefore = st.players[0].forest.length;
  const handBefore = st.players[0].hand.length;
  const good = S.applyAction(room, P1(room), { kind: 'play_free', cardUid: plantCard.uid, asTree: true });
  ok('植物牌免费放置成功', good.ok === true);
  eq('免费放置不扣费', good.paid, 0);
  eq('手牌减少 1 张', st.players[0].hand.length, handBefore - 1);
  eq('森林增加 1 棵', st.players[0].forest.length, forestBefore + 1);
  eq('额度用尽后清空', st.pendingFree, null);
}

// ---------- 4. pending：LichtungHandTyp(Fledermaus) → take_clearing ----------
// 注意：大蚊的 LichtungHandTyp 是 bonus，不是 immediate。
// bonus 触发条件：费用 > 0 且支付的每张牌叶子符号都与打出的牌匹配。
{
  const room = mkRoom(17);
  const st = room.state;
  st.players[0].hand.length = 0;
  st.players[0].hand.push(
    { uid: 1, kind: 'split',
      faces: [{ id: 'craneFly', tree: 'birch' }, { id: 'x', tree: 'birch' }],
      leafA: 'birch', leafB: 'birch', orient: 'h', face: null, hidden: null },
    { uid: 2, kind: 'tree', face: 'birch', leaf: 'birch', hidden: null },   // 支付用，叶子匹配
  );
  const cf = st.effectById.get('craneFly');
  cf.cost = 1;                       // 必须 > 0，否则 bonus 不判定

  // 空地放一张蝙蝠（bechsteinsBat）和一张非蝙蝠
  st.clearing = [
    { uid: 880001, kind: 'split', faces: [{ id: 'bechsteinsBat', tree: 'oak' }, { id: 'z', tree: 'oak' }], leafA: 'oak', leafB: 'oak' },
    { uid: 880002, kind: 'tree', face: 'birch', leaf: 'birch' },
  ];
  const t4 = plantTree(st, 0, 'birch');
  const r = S.applyAction(room, P1(room), {
    kind: 'play', cardUid: 1, pay: [2],
    treeUid: t4, slot: 'top', face: 0,
  });
  ok('大蚊可打出', r.ok === true);
  ok('大蚊 bonus 已触发', r.bonusFired === true);
  ok('额度类型为 clearing', st.pendingFree && st.pendingFree.kind === 'clearing');
  eq('额度要求 bat 类型', st.pendingFree.types[0], 'bat');

  // 取非蝙蝠 → 被拒
  const bad = S.applyAction(room, P1(room), { kind: 'take_clearing', uid: 880002 });
  eq('非蝙蝠牌被拒', bad.ok, false);

  // 取蝙蝠 → 成功入手
  const handBefore = st.players[0].hand.length;
  // 注意：打出大蚊时支付的桦树牌进了空地，所以基准要取「出牌后」的空地数
  const clearingBefore = st.clearing.length;
  const good = S.applyAction(room, P1(room), { kind: 'take_clearing', uid: 880001 });
  ok('蝙蝠牌可取', good.ok === true);
  eq('手牌增加 1 张', st.players[0].hand.length, handBefore + 1);
  eq('空地减少 1 张', st.clearing.length, clearingBefore - 1);
  eq('取牌后额度清空', st.pendingFree, null);
  eq('取牌后交出回合', st.currentPlayer, 1);
}

// ---------- 5. 真实计分牌跑到终局，得分非零 ----------
{
  const room = mkRoom(2026);
  const st = room.state;
  let guard = 0;
  let scorePlays = 0;
  let draws = 0;

  while (!st.ended && guard++ < 20000) {
    const gi = st.currentPlayer;
    const me = gi === 0 ? P1(room) : P2(room);
    const p = st.players[gi];

    // 手牌太少先抽牌：抽牌永远成功，能稳定推进牌堆
    if (p.hand.length < 2) {
      S.applyAction(room, me, { kind: 'draw', picks: [{ from: 'deck' }, { from: 'deck' }] });
      draws++;
      continue;
    }

    const treeCard = p.hand.find(c => c.kind === 'tree');
    const splitCard = p.hand.find(c => c.kind === 'split');
    const payPool = p.hand.filter(c => c.kind === 'tree').map(c => c.uid);

    if (treeCard) {
      const cost = (st.effectById.get(treeCard.face) || {}).cost || 0;
      const pay = payPool.filter(u => u !== treeCard.uid).slice(0, cost);
      if (pay.length >= cost) {
        const r = S.applyAction(room, me, { kind: 'play', cardUid: treeCard.uid, pay });
        if (r.ok) { scorePlays++; continue; }
      }
      // 付不起就抽牌推进
      S.applyAction(room, me, { kind: 'draw', picks: [{ from: 'deck' }, { from: 'deck' }] });
      draws++;
      continue;
    }

    if (splitCard) {
      const cost = (st.effectById.get(splitCard.faces[0].id) || {}).cost || 0;
      const pay = payPool.slice(0, cost);
      const tree = p.forest.find(t => ['top', 'bottom', 'left', 'right'].some(s => !t.slots[s]));
      if (tree && pay.length >= cost) {
        const slot = ['top', 'bottom', 'left', 'right'].find(s => !tree.slots[s]);
        const r = S.applyAction(room, me, {
          kind: 'play', cardUid: splitCard.uid, pay,
          treeUid: tree.uid, slot, face: 0,
        });
        if (r.ok) { scorePlays++; continue; }
      }
      // 没树或付不起：当树苗打出（0 费，稳定推进）
      const r = S.applyAction(room, me, { kind: 'play', cardUid: splitCard.uid, pay: [], asTree: true });
      if (r.ok) { scorePlays++; continue; }
    }

    // 兜底：抽牌
    S.applyAction(room, me, { kind: 'draw', picks: [{ from: 'deck' }, { from: 'deck' }] });
    draws++;
  }

  ok('真实对局在步数上限内结束', guard < 20000);
  ok('第三张冬卡触发终局', st.winterRevealed >= 3);
  eq('终局标记为 true', st.ended, true);

  const s0 = forest.scorePlayer(st, 0);
  const s1 = forest.scorePlayer(st, 1);
  ok('0 号得分非零', s0.total > 0);
  ok('至少一方得分大于零', s0.total + s1.total > 0);
  ok('0 号有计分明细', s0.detail.length > 0);
  console.log('  真实对局：甲 ' + s0.total + ' 分（' + s0.detail.length + ' 张计分牌），乙 ' + s1.total + ' 分');
  console.log('  森林：甲 ' + st.players[0].forest.length + ' 棵，乙 ' + st.players[1].forest.length + ' 棵');
  console.log('  出牌 ' + scorePlays + ' 次，抽牌 ' + draws + ' 次，冬卡 ' + st.winterRevealed + ' 张');

  S.finishGame(room);
  eq('结束后 phase 为 finished', room.phase, 'finished');
}

console.log('');
for (const p of pass) console.log('  PASS  ' + p);
for (const f of fail) console.log('  FAIL  ' + f);
console.log('');
console.log(`  ${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);