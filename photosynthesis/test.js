'use strict';
const P = require('./engine.js');

const pass = [], fail = [];
const ok = (n, c) => (c ? pass : fail).push(n);
const log = (...a) => console.log(...a);

// ---------- 1. 六角坐标 ----------
ok('distance self is 0', P.hexDistance({ q: 0, r: 0 }, { q: 0, r: 0 }) === 0);
ok('distance neighbor is 1', P.hexDistance({ q: 0, r: 0 }, { q: 1, r: 0 }) === 1);
ok('distance 2 away', P.hexDistance({ q: 0, r: 0 }, { q: 2, r: 0 }) === 2);
ok('distance diagonal', P.hexDistance({ q: 0, r: 0 }, { q: 1, r: -1 }) === 1);
ok('neighbors count 6', P.hexNeighbors({ q: 0, r: 0 }).length === 6);
ok('all neighbors at distance 1', P.hexNeighbors({ q: 0, r: 0 }).every(n => P.hexDistance({ q: 0, r: 0 }, n) === 1));

// ---------- 2. 棋盘 ----------
const board = P.buildBoard(2);
ok('board has 19 cells', board.length === 19);
const center = board.find(c => c.q === 0 && c.r === 0);
ok('center has 4 leaves', center && center.leaves === 4);
const ring1 = board.filter(c => c.dist === 1);
ok('ring1 has 6 cells', ring1.length === 6);
ok('ring1 has 3 leaves', ring1.every(c => c.leaves === 3));
const ring2 = board.filter(c => c.dist === 2);
ok('ring2 has 12 cells', ring2.length === 12);
ok('ring2 has 2 leaves', ring2.every(c => c.leaves === 2));

// ---------- 3. 建局 ----------
const g = P.createGame({ players: ['A', 'B'], seed: 1 });
ok('2 players', g.players.length === 2);
ok('start light 0', g.players.every(p => p.light === 0));
// 开局每人放 2 棵小树，库存从 4 降到 2
ok('small stock reduced by setup', g.players.every(p => p.supply[P.TREE.SMALL] === 2));
ok('seed supply untouched by setup', g.players.every(p => p.supply[P.TREE.SEED] === 4));
ok('large supply untouched by setup', g.players.every(p => p.supply[P.TREE.LARGE] === 2));
// 开局放树验证
const planted = g.board.filter(c => c.tree);
ok('setup planted 4 small trees total', planted.length === 4);
ok('each player has 2 trees on board',
   g.players.every(p => g.board.filter(c => c.tree && c.tree.owner === p.index).length === 2));
ok('all setup trees are small', planted.every(c => c.tree.size === P.TREE.SMALL));
ok('all setup trees on 1-leaf soil', planted.every(c => c.leaves === 1));
ok('18 total rounds', g.totalRounds === 18);
ok('not ended', g.ended === false);
ok('board has 37 cells (radius 3)', g.board.length === 37);
ok('has 4 distinct leaf values',
   new Set(g.board.map(c => c.leaves)).size === 4);

// ---------- 4. 遮影判定 ----------
// 太阳在北(0,-1)，影子朝南(0,+1)
const g2 = P.createGame({ players: ['A'], seed: 1 });
const c00 = g2.board.find(c => c.q === 0 && c.r === 0);
const cSouth = g2.board.find(c => c.q === 0 && c.r === 1);
c00.tree = { owner: 0, size: P.TREE.LARGE };   // 大树影子长 3
cSouth.tree = { owner: 0, size: P.TREE.SMALL }; // 小树
ok('large casts shadow on small to south', P.isShaded(g2.board, cSouth, 0) === true);

// 小树挡不住大树
const g3 = P.createGame({ players: ['A'], seed: 1 });
const d00 = g3.board.find(c => c.q === 0 && c.r === 0);
const dSouth = g3.board.find(c => c.q === 0 && c.r === 1);
d00.tree = { owner: 0, size: P.TREE.SMALL };
dSouth.tree = { owner: 0, size: P.TREE.LARGE };
ok('small cannot shade large', P.isShaded(g3.board, dSouth, 0) === false);

// 同级也挡
const g4 = P.createGame({ players: ['A'], seed: 1 });
const e00 = g4.board.find(c => c.q === 0 && c.r === 0);
const eSouth = g4.board.find(c => c.q === 0 && c.r === 1);
e00.tree = { owner: 0, size: P.TREE.MEDIUM };
eSouth.tree = { owner: 1, size: P.TREE.MEDIUM };
ok('same size shades each other', P.isShaded(g4.board, eSouth, 0) === true);

// 种子不产光也不挡
ok('seed generates 0 light', P.LIGHT_PER_SIZE[P.TREE.SEED] === 0);
ok('seed shadow length 0', P.SHADOW_LENGTH[P.TREE.SEED] === 0);

// ---------- 5. 光合作用 ----------
const g5 = P.createGame({ players: ['A', 'B'], seed: 1 });
// 清掉开局放的树，隔离测试场景
g5.board.forEach(c => { c.tree = null; });
const f1 = g5.board.find(c => c.q === 0 && c.r === 0);
const f2 = g5.board.find(c => c.q === 2 && c.r === -1);
f1.tree = { owner: 0, size: P.TREE.LARGE };    // 3 点
f2.tree = { owner: 1, size: P.TREE.MEDIUM };   // 2 点
const gained = P.photosynthesisPhase(g5);
ok('large gives 3', gained.find(x => x.player === 0).add === 3);
ok('medium gives 2', gained.find(x => x.player === 1).add === 2);
ok('light stored', g5.players[0].light === 3 && g5.players[1].light === 2);

// 光点上限 20
g5.players[0].light = 19;
f2.tree.owner = 0;
P.photosynthesisPhase(g5);
ok('light capped at 20', g5.players[0].light === 20);

// ---------- 6. 太阳轮转 ----------
const g6 = P.createGame({ players: ['A', 'B'], seed: 1 });
const startDir = g6.sunDir;
const r1 = P.nextRound(g6);
ok('sun rotates', g6.sunDir === (startDir + 1) % 6);
ok('round incremented', g6.round === 1);
ok('first player rotates', g6.firstPlayer === 1);
ok('activated cleared', g6.players.every(p => p.activated.size === 0));

// 跑满 18 回合（已结束则不再推进）
for (let i = 0; i < 20; i++) P.nextRound(g6);
ok('game ends after 18 rounds', g6.ended === true);
ok('round stops at totalRounds', g6.round === 18);

// ---------- 7. 动作：买 ----------
const g7 = P.createGame({ players: ['A'], seed: 1 });
g7.players[0].light = 10;
const b1 = P.buy(g7, 0, P.TREE.SMALL);
ok('buy small ok', b1.ok === true);
ok('light deducted', g7.players[0].light === 8);
ok('stock reduced', g7.players[0].supply[P.TREE.SMALL] === 1);

g7.players[0].light = 0;
const b2 = P.buy(g7, 0, P.TREE.SMALL);
ok('buy rejected without light', b2.ok === false);

// ---------- 8. 动作：种种子 ----------
const g8 = P.createGame({ players: ['A'], seed: 1 });
const s1 = g8.board.find(c => c.q === 0 && c.r === 0);
s1.tree = { owner: 0, size: P.TREE.MEDIUM };
const target = g8.board.find(c => c.q === 1 && c.r === 0);  // 距离 1
const p1 = P.plantSeed(g8, 0, 0, 0, 1, 0);
ok('plant seed ok', p1.ok === true);
ok('seed placed', target.tree && target.tree.size === P.TREE.SEED);
ok('seed supply reduced', g8.players[0].supply[0] === 3);
ok('tree activated', g8.players[0].activated.has('0,0'));

const p2 = P.plantSeed(g8, 0, 0, 0, 2, 0);   // 距离 2，中树只能 2 → 应该成功但格子已被占? 距离2空
ok('second plant from same tree rejected', p2.ok === false);

// 距离超限
const g9 = P.createGame({ players: ['A'], seed: 1 });
const t1 = g9.board.find(c => c.q === 0 && c.r === 0);
t1.tree = { owner: 0, size: P.TREE.SMALL };   // 小树只能投 1
const far = P.plantSeed(g9, 0, 0, 0, 2, 0);
ok('too far rejected', far.ok === false);

// ---------- 9. 动作：长大 ----------
const g10 = P.createGame({ players: ['A'], seed: 1 });
const u1 = g10.board.find(c => c.q === 0 && c.r === 0);
// 模拟真实来源：种子是从个人板取的，所以先扣库存
g10.players[0].supply[P.TREE.SEED]--;
u1.tree = { owner: 0, size: P.TREE.SEED };
const gr = P.growTree(g10, 0, 0, 0);
ok('grow seed to small ok', gr.ok === true);
ok('tree size now small', u1.tree.size === P.TREE.SMALL);
ok('small stock reduced', g10.players[0].supply[1] === 1);
ok('seed returned to supply', g10.players[0].supply[0] === 4);

const gr2 = P.growTree(g10, 0, 0, 0);
ok('same tree cannot grow twice', gr2.ok === false);

// ---------- 10. 动作：采计分标记 ----------
const g11 = P.createGame({ players: ['A'], seed: 1 });
const v1 = g11.board.find(c => c.q === 0 && c.r === 0);   // 中心 4 叶
v1.tree = { owner: 0, size: P.TREE.LARGE };
g11.players[0].light = 6;
const col = P.collectToken(g11, 0, 0, 0);
ok('collect ok', col.ok === true);
ok('token value = 4 leaves', col.value === 4);
ok('light deducted 4', g11.players[0].light === 2);
ok('cell cleared', v1.tree === null);
ok('large returned to supply', g11.players[0].supply[3] === 2);

// 只有大树能采
const g12 = P.createGame({ players: ['A'], seed: 1 });
const w1 = g12.board.find(c => c.q === 0 && c.r === 0);
w1.tree = { owner: 0, size: P.TREE.MEDIUM };
g12.players[0].light = 10;
ok('medium cannot collect', P.collectToken(g12, 0, 0, 0).ok === false);

// ---------- 11. 终局计分 ----------
const g13 = P.createGame({ players: ['A', 'B'], seed: 1 });
g13.players[0].tokens = [4, 3];
g13.players[0].light = 7;      // 7/3 = 2 分
g13.players[1].tokens = [2];
g13.players[1].light = 2;      // 2/3 = 0 分
const fs = P.finalScore(g13);
ok('player A total 9', fs[0].total === 9);
ok('player B total 2', fs[1].total === 2);
ok('ranking sorted', fs[0].player === 0);

log('');
for (const p of pass) log('  PASS  ' + p);
for (const f of fail) log('  FAIL  ' + f);
log('');
log(`  ${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);