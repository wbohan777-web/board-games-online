'use strict';
/**
 * Photosynthesis 规则引擎
 * 规则来源：BGA 官方规则摘要（Blue Orange 授权）
 *
 * 棋盘：六角格，4 个区（1-4 片叶子），越靠中心土壤越富（计分标记越值钱）
 * 太阳：6 个方位，每回合顺时针转一格；6 回合 = 1 圈；标准局 3 圈 = 18 回合
 *
 * 阶段一「光合作用」：每棵树按大小产光点，除非被遮挡
 *   种子 0 点 / 小树 1 点 / 中树 2 点 / 大树 3 点
 *   遮挡：影子沿太阳反方向延伸；被挡的树不产光点，
 *         除非它比遮挡者至少大一个等级
 *   光点上限 20
 *
 * 阶段二「生命循环」：买新物品 / 种种子 / 长大树 / 采计分标记
 *   每棵树每回合只能激活一次
 *   大树花 4 光点采计分标记
 *
 * 终局：3 圈后，计分标记总值 + 每 3 点未花光点算 1 分
 *       平局比场上种子和树的数量
 */

// ---------- 常量 ----------
const TREE = {
  SEED: 0,
  SMALL: 1,
  MEDIUM: 2,
  LARGE: 3,
};

const LIGHT_PER_SIZE = { 0: 0, 1: 1, 2: 2, 3: 3 };
const SHADOW_LENGTH = { 0: 0, 1: 1, 2: 2, 3: 3 };
const SEED_THROW = { 0: 0, 1: 1, 2: 2, 3: 3 };

// 个人板库存与价格（从下往上买）
const SUPPLY = {
  0: { count: 4, cost: 1 },   // 种子
  1: { count: 4, cost: 2 },   // 小树
  2: { count: 3, cost: 3 },   // 中树
  3: { count: 2, cost: 4 },   // 大树
};

const COLLECT_COST = 4;      // 大树采计分标记的光点成本
const LIGHT_CAP = 20;
const ROUNDS_PER_REVOLUTION = 6;

// ---------- 六角坐标 ----------
// 用轴向坐标 (q, r)；距离 = (|dq| + |dr| + |dq+dr|) / 2
function hexDistance(a, b) {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

function hexNeighbors(h) {
  const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  return dirs.map(([dq, dr]) => ({ q: h.q + dq, r: h.r + dr }));
}

function hexKey(h) { return h.q + ',' + h.r; }

// ---------- 棋盘生成 ----------
// 半径 2 的六角棋盘 = 19 格（1 中心 + 6 内环 + 12 外环）
// 分区按到中心的距离：0 → 4 叶（最富），1 → 3 叶，2 → 2 叶，3 → 1 叶
function buildBoard(radius = 3) {
  const cells = [];
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) {
      const dist = hexDistance({ q: 0, r: 0 }, { q, r });
      cells.push({
        q, r,
        dist,
        leaves: Math.max(1, 4 - dist),   // 中心 4 叶，往外 3 / 2 / 1 叶，共 4 区
        tree: null,
      });
    }
  }
  return cells;
}

// ---------- 太阳与影子 ----------
// 6 个太阳方位（顺时针）；影子朝太阳反方向
const SUN_DIRS = [
  { q: 0, r: -1 },   // 0: 北
  { q: 1, r: -1 },   // 1: 东北
  { q: 1, r: 0 },    // 2: 东南
  { q: 0, r: 1 },    // 3: 南
  { q: -1, r: 1 },   // 4: 西南
  { q: -1, r: 0 },   // 5: 西北
];

/**
 * 计算某格在某太阳方位下是否被遮挡。
 * 影子从树出发，沿「太阳反方向」延伸 SHADOW_LENGTH[size] 格。
 * 被遮挡的树不产光点，除非它比遮挡者至少大一个等级。
 */
function isShaded(board, cell, sunDir) {
  const idx = SUN_DIRS[sunDir];
  const mySize = cell.tree ? cell.tree.size : -1;
  if (mySize < 0) return false;

  // 太阳在 sunDir 方向，光沿 -sunDir 射来，影子落在 +(-sunDir) = 沿 sunDir 的反侧
  // 所以遮挡者位于 cell 沿「太阳方向」回退处：src = cell + sunDir * d
  for (let d = 1; d <= 3; d++) {
    const srcQ = cell.q + idx.q * d;
    const srcR = cell.r + idx.r * d;
    const src = board.find(c => c.q === srcQ && c.r === srcR);
    if (!src || !src.tree) continue;
    const srcSize = src.tree.size;
    const reach = SHADOW_LENGTH[srcSize];
    if (reach < d) continue;                       // 影子够不到
    if (mySize >= srcSize + 1) continue;           // 我比它大一级以上，不受影响
    return true;
  }
  return false;
}

// ---------- 游戏状态 ----------
function createGame({ players, seed = 1, revolutions = 3 }) {
  const board = buildBoard(3);   // 半径 3 = 37 格，四区（4/3/2/1 叶）完整
  const state = {
    board,
    sunDir: 0,
    round: 0,
    revolutions,
    totalRounds: revolutions * ROUNDS_PER_REVOLUTION,
    ended: false,
    currentPlayer: 0,
    firstPlayer: 0,
    players: players.map((name, i) => ({
      index: i,
      name,
      light: 0,
      supply: { 0: SUPPLY[0].count, 1: SUPPLY[1].count, 2: SUPPLY[2].count, 3: SUPPLY[3].count },
      tokens: [],
      activated: new Set(),
      score: 0,
    })),
    seed,
  };

  // 开局前置阶段：每人轮流在「1 叶区」放 2 棵小树
  // 没有这一步，第一回合所有人都产不出光点，也买不起任何东西，局面直接死锁
  const oneLeaf = state.board.filter(c => c.leaves === 1 && !c.tree);
  let cursor = 0;
  for (const p of state.players) {
    for (let k = 0; k < 2; k++) {
      while (cursor < oneLeaf.length && oneLeaf[cursor].tree) cursor++;
      if (cursor >= oneLeaf.length) break;
      const cell = oneLeaf[cursor++];
      cell.tree = { owner: p.index, size: TREE.SMALL };
      p.supply[TREE.SMALL]--;      // 从个人板取小树
    }
  }

  return state;
}

// ---------- 光合作用阶段 ----------
function photosynthesisPhase(state) {
  const gained = [];
  for (const p of state.players) {
    let add = 0;
    for (const cell of state.board) {
      if (!cell.tree || cell.tree.owner !== p.index) continue;
      if (cell.tree.size === 0) continue;                 // 种子不产光点
      if (isShaded(state.board, cell, state.sunDir)) continue;
      add += LIGHT_PER_SIZE[cell.tree.size];
    }
    p.light = Math.min(LIGHT_CAP, p.light + add);
    gained.push({ player: p.index, add, total: p.light });
  }
  return gained;
}

// ---------- 回合推进 ----------
function nextRound(state) {
  if (state.ended) return { ended: true };      // 已结束则不再推进
  // 第 1 回合在开局即生效（太阳初始方位），此函数推进到下一回合
  if (state.round >= state.totalRounds) {
    state.ended = true;
    return { ended: true };
  }
  state.round++;
  // 太阳顺时针转一格
  state.sunDir = (state.sunDir + 1) % 6;
  // 清空激活记录
  for (const p of state.players) p.activated.clear();
  // 首玩家顺时针轮换
  state.firstPlayer = (state.firstPlayer + 1) % state.players.length;
  state.currentPlayer = state.firstPlayer;
  const gained = photosynthesisPhase(state);
  return { ended: false, sunDir: state.sunDir, gained };
}

// ---------- 动作 ----------
function findCell(state, q, r) {
  return state.board.find(c => c.q === q && c.r === r);
}

/** 买新物品：从个人板底部往上买 */
function buy(state, playerIndex, size) {
  const p = state.players[playerIndex];
  const s = SUPPLY[size];
  if (s == null) return { ok: false, error: 'bad size' };
  if (p.supply[size] <= 0) return { ok: false, error: 'no stock' };
  if (p.light < s.cost) return { ok: false, error: 'not enough light' };
  p.light -= s.cost;
  p.supply[size]--;
  return { ok: true, size, left: p.supply[size], light: p.light };
}

/** 种种子：从某棵树向目标空格投种子，距离受树大小限制 */
function plantSeed(state, playerIndex, fromQ, fromR, toQ, toR) {
  const p = state.players[playerIndex];
  if (p.supply[TREE.SEED] <= 0) return { ok: false, error: 'no seed in supply' };
  const src = findCell(state, fromQ, fromR);
  const dst = findCell(state, toQ, toR);
  if (!src || !dst) return { ok: false, error: 'cell not on board' };
  if (!src.tree || src.tree.owner !== playerIndex) return { ok: false, error: 'not your tree' };
  if (src.tree.size === 0) return { ok: false, error: 'seed cannot throw seeds' };
  if (src.tree.size < TREE.SMALL) return { ok: false, error: 'too small' };
  if (dst.tree) return { ok: false, error: 'cell occupied' };
  const key = hexKey(src);
  if (p.activated.has(key)) return { ok: false, error: 'tree already activated this round' };
  const d = hexDistance({ q: fromQ, r: fromR }, { q: toQ, r: toR });
  if (d > SEED_THROW[src.tree.size]) return { ok: false, error: 'too far: ' + d };

  dst.tree = { owner: playerIndex, size: TREE.SEED };
  p.supply[TREE.SEED]--;
  p.activated.add(key);
  return { ok: true };
}

/** 长大树：种子→小→中→大 */
function growTree(state, playerIndex, q, r) {
  const p = state.players[playerIndex];
  const cell = findCell(state, q, r);
  if (!cell) return { ok: false, error: 'cell not on board' };
  if (!cell.tree || cell.tree.owner !== playerIndex) return { ok: false, error: 'not your tree' };
  const cur = cell.tree.size;
  if (cur >= TREE.LARGE) return { ok: false, error: 'already large' };
  const next = cur + 1;
  if (p.supply[next] <= 0) return { ok: false, error: 'no stock for size ' + next };
  const key = hexKey(cell);
  if (p.activated.has(key)) return { ok: false, error: 'tree already activated this round' };

  p.supply[next]--;
  p.supply[cur]++;          // 原尺寸棋子退回个人板
  cell.tree.size = next;
  p.activated.add(key);
  return { ok: true, size: next };
}

/** 采计分标记：大树花 4 光点 */
function collectToken(state, playerIndex, q, r, tokenValue) {
  const p = state.players[playerIndex];
  const cell = findCell(state, q, r);
  if (!cell) return { ok: false, error: 'cell not on board' };
  if (!cell.tree || cell.tree.owner !== playerIndex) return { ok: false, error: 'not your tree' };
  if (cell.tree.size !== TREE.LARGE) return { ok: false, error: 'only large tree can collect' };
  const key = hexKey(cell);
  if (p.activated.has(key)) return { ok: false, error: 'tree already activated this round' };
  if (p.light < COLLECT_COST) return { ok: false, error: 'not enough light' };

  p.light -= COLLECT_COST;
  // 标记值 = 该格土壤叶子数（越富越值钱）
  const val = tokenValue != null ? tokenValue : cell.leaves;
  p.tokens.push(val);
  // 大树退回个人板（超出物理棋子数量则移出游戏）
  if (p.supply[TREE.LARGE] < SUPPLY[TREE.LARGE].count) p.supply[TREE.LARGE]++;
  cell.tree = null;
  p.activated.add(key);
  return { ok: true, value: val, total: p.tokens.reduce((a, b) => a + b, 0) };
}

// ---------- 终局计分 ----------
function finalScore(state) {
  return state.players.map(p => {
    const tokens = p.tokens.reduce((a, b) => a + b, 0);
    const leftover = Math.floor(p.light / 3);
    const treesOnBoard = state.board.filter(c => c.tree && c.tree.owner === p.index).length;
    return {
      player: p.index,
      name: p.name,
      tokens,
      leftover,
      total: tokens + leftover,
      treesOnBoard,
    };
  }).sort((a, b) => b.total - a.total || b.treesOnBoard - a.treesOnBoard);
}

module.exports = {
  TREE, LIGHT_PER_SIZE, SHADOW_LENGTH, SEED_THROW, SUPPLY,
  COLLECT_COST, LIGHT_CAP, ROUNDS_PER_REVOLUTION, SUN_DIRS,
  hexDistance, hexNeighbors, hexKey, buildBoard, isShaded,
  createGame, photosynthesisPhase, nextRound,
  buy, plantSeed, growTree, collectToken, finalScore, findCell,
};