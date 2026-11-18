'use strict';
/**
 * extraTurn（额外回合）确定性用例
 *
 * 背景：基础牌堆里没有「即时 Extrazug」牌——
 *   - 狼的额外回合是奖励效果（bonus），需支付牌全部带匹配叶子符号才触发
 *   - 即时 Extrazug 只存在于 Alpine 的 steinbock、Woodland Edge 的 europeanBison
 * 因此联机剧本（只用基础牌堆）无法自然抽到这类牌。
 *
 * 本用例绕过牌堆随机性：手工把 steinbock 放进手牌，
 * 直接调用 server.js 导出的 applyAction，验证
 *   1. actionPlay 正确识别并返回 extraTurn
 *   2. applyAction 不把 currentPlayer 推给下家
 *   3. 普通牌仍然正常推进回合（对照组）
 */

const forest = require('./forest-shuffle/engine.js');
const { applyAction } = require('./server.js');

const pass = [], fail = [];
const ok = (n, c) => (c ? pass : fail).push(n);

// ---------- 构造最小房间 ----------
function makeRoom(seed) {
  const state = forest.createGame({ players: ['甲', '乙'], seed });
  const p0 = { id: 'p0', name: '甲', gameIndex: 0, ws: null, colorIdx: 0 };
  const p1 = { id: 'p1', name: '乙', gameIndex: 1, ws: null, colorIdx: 1 };
  const room = {
    code: 'TST1',
    game: 'forest',
    hostId: 'p0',
    players: new Map([['p0', p0], ['p1', p1]]),
    phase: 'playing',
    state,
    createdAt: Date.now(),
  };
  state.currentPlayer = 0;
  // 给玩家 0 种一棵树，提供挂卡槽位
  state.players[0].forest.push({
    uid: 9001,
    treeId: 'beech',
    slots: { top: null, bottom: null, left: null, right: null },
  });
  return { room, state, p0, p1 };
}

// ---------- 用例一：steinbock 带即时 Extrazug ----------
{
  const { room, state, p0 } = makeRoom(11);

  // Alpine 扩展里 steinbock 是双面卡的 b 面
  const steinbock = {
    uid: 9002,
    kind: 'split',
    faces: [
      { id: 'alpineMarmot', tree: 'beech' },
      { id: 'steinbock', tree: 'stonePine' },
    ],
    orient: 'h',
    face: null,
    hidden: null,
  };
  state.players[0].hand.push(steinbock);

  // steinbock 费用 3，取 3 张非本牌支付
  const pay = state.players[0].hand
    .filter(c => c.uid !== steinbock.uid)
    .slice(0, 3)
    .map(c => c.uid);

  const r = applyAction(room, p0, {
    kind: 'play',
    cardUid: steinbock.uid,
    pay,
    face: 1,
    treeUid: 9001,
    slot: 'top',
  });

  ok('steinbock play accepted', r.ok === true);
  ok('playedFaceId resolved to steinbock', r.playedFaceId === 'steinbock');
  ok('engine reports extraTurn', r.extraTurn === true);
  ok('currentPlayer stays with the same player', state.currentPlayer === 0);
  ok('extraTurns counter incremented', state.extraTurns === 1);
  ok('card actually slotted into tree', !!state.players[0].forest[0].slots.top);
  ok('slotted face is steinbock', state.players[0].forest[0].slots.top.faceId === 'steinbock');
}

// ---------- 用例二：对照组，普通牌正常推进回合 ----------
{
  const { room, state, p0 } = makeRoom(12);

  const treeCard = state.players[0].hand.find(c => c.kind === 'tree');
  ok('control group has a tree card', !!treeCard);

  if (treeCard) {
    const pay = state.players[0].hand
      .filter(c => c.uid !== treeCard.uid)
      .slice(0, 6)
      .map(c => c.uid);

    const r = applyAction(room, p0, { kind: 'play', cardUid: treeCard.uid, pay });

    ok('normal play accepted', r.ok === true);
    ok('normal play has no extraTurn', r.extraTurn === false);
    ok('normal play advances turn to player 1', state.currentPlayer === 1);
    ok('extraTurns not incremented for normal card', !state.extraTurns);
  }
}

// ---------- 用例三：抽牌动作仍正常推进 ----------
{
  const { room, state, p0 } = makeRoom(13);
  const r = applyAction(room, p0, { kind: 'draw', picks: [{ from: 'deck' }, { from: 'deck' }] });
  ok('draw accepted', r.ok === true);
  ok('draw advances turn', state.currentPlayer === 1);
}

// ---------- 输出 ----------
console.log('');
for (const p of pass) console.log('  PASS  ' + p);
for (const f of fail) console.log('  FAIL  ' + f);
console.log('');
console.log(`  ${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);