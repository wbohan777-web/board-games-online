'use strict';
const E = require('./engine.js');

function log(...a) { console.log(...a); }
const pass = [], fail = [];
const ok = (n, c) => (c ? pass : fail).push(n);

// ---------- 1. 数据完整性 ----------
const { list, byId } = E.loadCards();
ok('cards loaded', list.length === 101);
ok('has tree category', list.some(c => c.category === 'tree'));
ok('has cave', byId.has('cave'));

const spec = require('./spec.json');
ok('deck size 158', spec.meta.deckSize === 158);
ok('split cards 56', spec.meta.splitCards === 56);
const treeTotal = Object.values(spec.meta.treeCopies).reduce((a, b) => a + b, 0);
ok('tree copies 66', treeTotal === 66);

// ---------- 2. 建局 ----------
const g = E.createGame({ players: ['A', 'B', 'C'], seed: 42 });
ok('3 players', g.players.length === 3);
ok('each hand 6', g.players.every(p => p.hand.length === 6));
ok('deck has cards', g.deck.length > 100);
ok('not ended', g.ended === false);
ok('winter count 3 in deck', g.deck.filter(c => c.kind === 'winter').length === 3);

// 冬卡应分布在牌堆后 1/3
const winterPos = g.deck.map((c, i) => c.kind === 'winter' ? i : -1).filter(i => i >= 0);
const twoThirds = Math.floor(g.deck.length * 2 / 3);
ok('winter in last third', winterPos.every(i => i >= twoThirds - 2));

// ---------- 3. 抽牌动作 ----------
const before = g.players[0].hand.length;
const r1 = E.actionDraw(g, 0, [{ from: 'deck' }, { from: 'deck' }]);
ok('draw ok', r1.ok === true);
ok('drew 2', g.players[0].hand.length === before + 2);

// ---------- 4. 打树牌 ----------
// 找一张树牌
const treeCard = g.players[0].hand.find(c => c.kind === 'tree');
ok('has tree card in hand', !!treeCard);

if (treeCard) {
  const payCards = g.players[0].hand.filter(c => c.uid !== treeCard.uid).slice(0, 6);
  const r2 = E.actionPlay(g, 0, {
    cardUid: treeCard.uid,
    pay: payCards.map(c => c.uid),
  });
  ok('play tree ok', r2.ok === true);
  ok('forest has 1 tree', g.players[0].forest.length === 1);
  ok('tree has 4 slots', g.players[0].forest[0] && Object.keys(g.players[0].forest[0].slots).length === 4);
}

// ---------- 5. 打双面卡 ----------
const splitCard = g.players[0].hand.find(c => c.kind === 'split');
const targetTree = g.players[0].forest[0];
if (splitCard && targetTree) {
  const payCards = g.players[0].hand.filter(c => c.uid !== splitCard.uid).slice(0, 6);
  const r3 = E.actionPlay(g, 0, {
    cardUid: splitCard.uid,
    pay: payCards.map(c => c.uid),
    face: 0,
    treeUid: targetTree.uid,
    slot: 'top',
  });
  ok('play split ok', r3.ok === true);
  ok('slot filled', !!targetTree.slots.top);
  ok('hidden face recorded', !!(targetTree.slots.top && targetTree.slots.top.hiddenFaceId));
  ok('hidden != visible', targetTree.slots.top && targetTree.slots.top.faceId !== targetTree.slots.top.hiddenFaceId);
}

// ---------- 6. 计分 ----------
const sc = E.scorePlayer(g, 0);
ok('score is number', typeof sc.total === 'number');
ok('score >= 0', sc.total >= 0);

// 关键回归：林中有牌就必须得分（防止 symbols/tags 丢失导致静默归零）
const visible = E.collectVisibleCards(g.players[0], byId);
ok('visible cards collected', visible.length >= 2);
ok('visible cards carry symbols', visible.every(v => Array.isArray(v.symbols)));
ok('visible cards carry zone', visible.some(v => v.zone));
ok('score > 0 with cards in forest', sc.total > 0);
ok('score detail not empty', sc.detail.length > 0);
log('  player0 score =', sc.total, 'detail:', JSON.stringify(sc.detail));

// ---------- 7. 树苗（背面朝下） ----------
const anyCard = g.players[0].hand[0];
if (anyCard) {
  const r4 = E.actionPlay(g, 0, { cardUid: anyCard.uid, asTree: true, pay: [] });
  ok('sapling ok', r4.ok === true);
  ok('sapling added', g.players[0].forest.some(t => t.treeId === 'sapling'));
}

// ---------- 8. 洞穴 ----------
const caveCard = g.players[0].hand[0];
if (caveCard) {
  const r5 = E.actionPlay(g, 0, { cardUid: caveCard.uid, cave: true, pay: [] });
  ok('cave ok', r5.ok === true);
  ok('cave counted', g.players[0].cave.length === 1);
  const sc2 = E.scorePlayer(g, 0);
  ok('cave adds 1pt', sc2.total === sc.total + 1);
}

// ---------- 9. 冬卡终局 ----------
let guard = 0;
while (!g.ended && guard < 3000) {
  E.drawFromDeck(g, null);
  guard++;
}
ok('game ends on 3rd winter', g.ended === true);
ok('all 3 winters revealed', g.winterRevealed === 3);
log('  game ended after', guard, 'draws; deck left =', g.deck.length);

// ---------- 10. 手牌上限 ----------
const g2 = E.createGame({ players: ['X'], seed: 7 });
g2.players[0].hand.length = 10;
const r6 = E.actionDraw(g2, 0, []);
ok('reject draw at 10 cards', r6.ok === false);

// ---------- 9. 付费规则（关键：费用来自 spec.json 的 cost） ----------
{
  const gpay = E.createGame({ players: ['P'], seed: 99 });
  const p = gpay.players[0];

  // 找一张有明确费用的树牌（oak 2 费）
  const oak = { uid: 77001, kind: 'tree', face: 'oak', hidden: null };
  p.hand.length = 0;
  p.hand.push(oak);
  // 只给 1 张支付牌（不足 2 费）
  const pay1 = { uid: 77002, kind: 'tree', face: 'birch', hidden: null };
  p.hand.push(pay1);

  const rShort = E.actionPlay(gpay, 0, { cardUid: oak.uid, pay: [pay1.uid] });
  ok('reject play when payment insufficient', rShort.ok === false);
  ok('insufficient play reports error', /pay|need/i.test(rShort.error || ''));
  ok('oak still in hand after rejection', p.hand.some(c => c.uid === oak.uid));
  ok('forest unchanged after rejection', p.forest.length === 0);

  // 补足到 2 张支付牌
  const pay2 = { uid: 77003, kind: 'tree', face: 'birch', hidden: null };
  const pay3 = { uid: 77004, kind: 'tree', face: 'birch', hidden: null };
  p.hand.push(pay2, pay3);

  const rOk = E.actionPlay(gpay, 0, { cardUid: oak.uid, pay: [pay2.uid, pay3.uid] });
  ok('accept play when payment sufficient', rOk.ok === true);
  ok('oak planted in forest', p.forest.some(t => t.treeId === 'oak'));
  ok('exactly 2 cards consumed as payment', !p.hand.some(c => c.uid === pay2.uid) && !p.hand.some(c => c.uid === pay3.uid));
  ok('payment cards went to clearing', gpay.clearing.some(c => c.uid === pay2.uid));

  // 0 费牌（桦树）不需要支付
  const gfree = E.createGame({ players: ['P'], seed: 98 });
  const pf = gfree.players[0];
  const birch = { uid: 78001, kind: 'tree', face: 'birch', hidden: null };
  pf.hand.length = 0;
  pf.hand.push(birch);
  const rFree = E.actionPlay(gfree, 0, { cardUid: birch.uid, pay: [] });
  ok('zero-cost card plays without payment', rFree.ok === true);

  // 树苗 / 洞穴不付费
  const gsapling = E.createGame({ players: ['P'], seed: 97 });
  const ps = gsapling.players[0];
  const anyCard = ps.hand[0];
  const rSap = E.actionPlay(gsapling, 0, { cardUid: anyCard.uid, asTree: true, pay: [] });
  ok('sapling needs no payment', rSap.ok === true);

  const gcave = E.createGame({ players: ['P'], seed: 96 });
  const pc2 = gcave.players[0];
  const caveCard = pc2.hand[0];
  const rCave = E.actionPlay(gcave, 0, { cardUid: caveCard.uid, cave: true, pay: [] });
  ok('cave needs no payment', rCave.ok === true);
}

// ---------- 10. 奖励效果：支付牌须全带匹配叶子符号 ----------
{
  // douglasFir 是 2 费树，bonus = Extrazug；叶子符号 = douglasFir
  const gb = E.createGame({ players: ['P'], seed: 55 });
  const pb = gb.players[0];

  const df = { uid: 88001, kind: 'tree', face: 'douglasFir', leaf: 'douglasFir', hidden: null };
  // 两张都带 douglasFir 符号的支付牌
  const payMatch1 = { uid: 88002, kind: 'tree', face: 'douglasFir', leaf: 'douglasFir', hidden: null };
  const payMatch2 = { uid: 88003, kind: 'split', faces: [{ id: 'europeanHare', tree: 'douglasFir' }, { id: 'europeanBadger', tree: 'oak' }], leafA: 'douglasFir', leafB: 'oak', hidden: null };

  pb.hand.length = 0;
  pb.hand.push(df, payMatch1, payMatch2);

  const rMatch = E.actionPlay(gb, 0, { cardUid: df.uid, pay: [payMatch1.uid, payMatch2.uid] });
  ok('bonus play accepted', rMatch.ok === true);
  ok('bonus fired when all payments match leaf', rMatch.bonusFired === true);
  ok('bonus is Extrazug for douglasFir', /Extrazug/.test(rMatch.bonusEffect || ''));
  ok('bonus grants extra turn', rMatch.extraTurn === true);

  // 对照组：一张支付牌不带匹配符号 → bonus 不触发
  const gb2 = E.createGame({ players: ['P'], seed: 56 });
  const pb2 = gb2.players[0];
  const df2 = { uid: 89001, kind: 'tree', face: 'douglasFir', leaf: 'douglasFir', hidden: null };
  const payOk = { uid: 89002, kind: 'tree', face: 'douglasFir', leaf: 'douglasFir', hidden: null };
  const payBad = { uid: 89003, kind: 'tree', face: 'birch', leaf: 'birch', hidden: null };
  pb2.hand.length = 0;
  pb2.hand.push(df2, payOk, payBad);

  const rNo = E.actionPlay(gb2, 0, { cardUid: df2.uid, pay: [payOk.uid, payBad.uid] });
  ok('non-matching play still accepted', rNo.ok === true);
  ok('bonus not fired with mismatched leaf', rNo.bonusFired === false);
  ok('no extra turn without bonus', rNo.extraTurn === false);
}

// ---------- 输出 ----------
log('');
for (const p of pass) log('  PASS  ' + p);
for (const f of fail) log('  FAIL  ' + f);
log('');
log(`  ${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);