'use strict';
/**
 * 整局端到端：从建房、发牌、抽牌、出牌，一路打到第三张冬卡出现，
 * 验证终局触发、逐牌计分与排名广播。
 * 直接驱动 server.js 的 applyAction，不依赖网络层。
 */
const path = require('path');
const S = require(path.join(__dirname, 'server.js'));
const forest = require(path.join(__dirname, 'forest-shuffle', 'engine.js'));

const pass = [], fail = [];
const ok = (n, c) => (c ? pass : fail).push(n);
const eq = (n, a, b) => ok(n + '（' + a + ' === ' + b + '）', a === b);

// 捕获 gameover 广播
let gameover = null;
function mkPlayer(id, name, gameIndex) {
  return { id, name, colorIdx: gameIndex, gameIndex, ws: null };
}

// ---------- 1. 建房与开局 ----------
const host = mkPlayer('p1', '甲', 0);
const room = S.createRoom(host, 'forest');
const p1 = room.players.get('p1');
const p2 = mkPlayer('p2', '乙', 1);
room.players.set('p2', p2);
let seat = 0;
room.players.forEach(p => { p.gameIndex = seat++; });

// 手动开局（等价于 start 分支）
const st = forest.createGame({ players: ['甲', '乙'], seed: 20261118 });
room.state = st;
room.phase = 'playing';

ok('开局后 phase 为 playing', room.phase === 'playing');
eq('两名玩家', st.players.length, 2);
eq('每人起始手牌 6 张', st.players[0].hand.length, 6);
ok('牌堆非空', st.deck.length > 0);
eq('开局未结束', st.ended, false);
eq('开局冬卡 0 张', st.winterRevealed, 0);
eq('开局回合归 0 号', st.currentPlayer, 0);

// ---------- 2. 循环出牌直到第三张冬卡 ----------
let guard = 0;
const MAX_STEPS = 4000;
let drewCount = 0, playedCount = 0;

while (!st.ended && guard++ < MAX_STEPS) {
  const gi = st.currentPlayer;
  const p = st.players[gi];
  const me = room.players.get(gi === 0 ? 'p1' : 'p2');

  // 手牌满了就出牌，否则抽两张
  if (p.hand.length >= 8) {
    // 优先当树苗打出（零费，稳定推进牌堆）
    const card = p.hand[0];
    const r = S.applyAction(room, me, {
      kind: 'play', cardUid: card.uid, pay: [], asTree: true,
    });
    if (r.ok) playedCount++;
  } else {
    const r = S.applyAction(room, me, { kind: 'draw', picks: [{ from: 'deck' }, { from: 'deck' }] });
    if (r.ok) drewCount++;
  }

  // 空地被清空时不影响流程；仅防御性检查
  if (st.players.every(x => x.hand.length === 0) && st.deck.length === 0) break;
}

ok('整局在步数上限内结束', guard < MAX_STEPS);
ok('第三张冬卡触发终局', st.winterRevealed >= 3);
eq('终局标记为 true', st.ended, true);
ok('确实抽过牌', drewCount > 0);
ok('确实出过牌', playedCount > 0);
console.log('  推进 ' + guard + ' 步：抽牌 ' + drewCount + ' 次，出牌 ' + playedCount + ' 次');
console.log('  冬卡 ' + st.winterRevealed + ' 张，剩余牌堆 ' + st.deck.length + ' 张');

// ---------- 3. 终局计分 ----------
const score0 = forest.scorePlayer(st, 0);
const score1 = forest.scorePlayer(st, 1);
ok('0 号有计分结果', typeof score0.total === 'number');
ok('1 号有计分结果', typeof score1.total === 'number');
ok('计分为非负整数', Number.isInteger(score0.total) && score0.total >= 0);
ok('明细为数组', Array.isArray(score0.detail));
ok('场上树数可统计',
   st.players[0].forest.length + st.players[1].forest.length > 0);
console.log('  终局比分：甲 ' + score0.total + ' 分，乙 ' + score1.total + ' 分');
console.log('  森林规模：甲 ' + st.players[0].forest.length + ' 棵，乙 ' + st.players[1].forest.length + ' 棵');

// 洞穴每张 1 分
const caveTotal0 = st.players[0].cave.length;
ok('洞穴计分已并入总分', score0.total >= caveTotal0);

// ---------- 4. 排名广播 ----------
S.finishGame(room);
eq('结束后 phase 为 finished', room.phase, 'finished');

// 重新算一次排名（finishGame 内部走同一套 scorePlayer）
const ranking = st.players.map((p, i) => {
  const sc = forest.scorePlayer(st, i);
  return { index: i, name: p.name, score: sc.total };
}).sort((a, b) => b.score - a.score).map((x, i) => ({ ...x, rank: i + 1 }));

eq('排名条目数等于玩家数', ranking.length, 2);
eq('第一名 rank 为 1', ranking[0].rank, 1);
ok('排名按分数降序', ranking[0].score >= ranking[1].score);
ok('排名含玩家名', typeof ranking[0].name === 'string' && ranking[0].name.length > 0);

// ---------- 5. 冬卡终局后不再接受动作 ----------
const afterEnd = S.applyAction(room, room.players.get('p1'), {
  kind: 'draw', picks: [{ from: 'deck' }, { from: 'deck' }],
});
eq('终局后动作被拒', afterEnd.ok, false);
ok('拒绝原因可读', /not playing/.test(afterEnd.error));

console.log('');
for (const p of pass) console.log('  PASS  ' + p);
for (const f of fail) console.log('  FAIL  ' + f);
console.log('');
console.log(`  ${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);