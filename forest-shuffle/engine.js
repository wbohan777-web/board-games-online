'use strict';
/**
 * Forest Shuffle 规则引擎
 * 数据来源：
 *   - 计分规则 / 卡牌类别：cards-forest.json（101 种）
 *   - 费用 / 牌堆结构 / 即时效果：mischwald Rust 实现（158 张牌堆，56 张双面卡）
 *   - 回合流程：BGA 官方规则摘要
 *
 * 规则要点：
 *   - 每回合二选一：抽两张（空地/牌堆），或打一张牌（弃牌支付费用）
 *   - 手牌上限 10；空地达 10 张，回合结束时清空
 *   - 树牌打出时从牌堆翻一张进空地
 *   - 任意手牌可背面朝下当树苗（无树种）
 *   - 双面卡只保留一面，另一面永久隐藏
 *   - 第三张冬卡出现立即结束
 */

const fs = require('fs');
const path = require('path');
const effects = require('./effects.js');

const DATA_DIR = __dirname;

// ---------- 数据加载 ----------
function loadCards() {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards.json'), 'utf8'));
  const byId = new Map();
  for (const c of raw) byId.set(c.id, c);
  return { list: raw, byId };
}

// ---------- 牌堆生成 ----------
/**
 * deck 结构来自 Rust 实现：
 *   treeCopies: { birch: 10, beech: 10, ... }
 *   splitCards: [{ a:'wolf', aTree:'douglasFir', b:'gnat', bTree:'chestnut', orient:'h' }, ...]
 * 每张双面卡实例化成一个对象，两面都可选。
 */
function buildDeck(spec) {
  const cards = [];
  let uid = 0;

  // 数据在 spec.meta.treeCopies；双面卡数组在 spec.deck
  const treeCopies = (spec.meta && spec.meta.treeCopies) || spec.treeCopies || {};
  const splits = spec.deck || spec.splitCards || [];

  for (const [treeId, n] of Object.entries(treeCopies)) {
    for (let i = 0; i < n; i++) {
      // 树牌的叶子符号就是它自己
      cards.push({ uid: uid++, kind: 'tree', face: treeId, leaf: treeId, hidden: null });
    }
  }

  for (const s of splits) {
    if (!s || !s.a || !s.b) continue;
    cards.push({
      uid: uid++,
      kind: 'split',
      // 两面：a 面挂 aTree 类型的树，b 面挂 bTree
      faces: [
        { id: s.a, tree: s.aTree },
        { id: s.b, tree: s.bTree },
      ],
      // 双面卡的两个叶子符号；支付时只要任一面匹配即可（原版规则）
      leafA: s.aTree,
      leafB: s.bTree,
      orient: s.orient,
      face: null,     // 未打出时两面都可用
      hidden: null,   // 打出后记录被压住的那一面
    });
  }

  return cards;
}

// ---------- 洗牌（可注入种子，便于测试复现） ----------
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 游戏状态 ----------
function createGame({ players, seed = 1, expansions = ['base'] }) {
  const { byId } = loadCards();
  const spec = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'spec.json'), 'utf8'));
  const rng = makeRng(seed);

  // 效果索引：cards.json 只存计分规则，immediate/bonus 存在 spec.json 的卡牌列表里。
  // 这里合并成一张按英文 id 索引的表，供 actionPlay 查效果。
  const effectById = new Map();
  for (const group of ['base', 'alpine', 'woodland']) {
    for (const c of (spec.cards && spec.cards[group]) || []) {
      if (c.ident) {
        effectById.set(c.ident, {
          immediate: c.immediate || 'Effekt::Keiner',
          bonus: c.bonus || 'Effekt::Keiner',
          persistent: c.persistent || 'Dauereffekt::Keiner',
          cost: c.cost,
          types: c.types || [],
        });
      }
    }
  }

  let deck = buildDeck(spec);

  // 冬卡：三张，洗进牌堆后 1/3
  const winterCount = 3;
  const deckShuffled = shuffle(deck, rng);
  const cut = Math.floor(deckShuffled.length * 2 / 3);
  const head = deckShuffled.slice(0, cut);
  const tail = deckShuffled.slice(cut);
  for (let i = 0; i < winterCount; i++) {
    tail.splice(Math.floor(rng() * tail.length), 0, { uid: 900000 + i, kind: 'winter' });
  }
  deck = head.concat(tail);

  const state = {
    byId,
    spec,
    effectById,
    rng,
    deck,
    clearing: [],      // 空地（弃牌堆，可被抽）
    winterRevealed: 0,
    ended: false,
    turn: 0,
    currentPlayer: 0,
    // 保留回合：waterVole 的「任意树苗」与 mole 的「付费连打」用这个字段维持连续出牌
    turnMode: null,
    // 免费放置额度：EinsKostenlosAblegen 系列结算成可连续使用的额度
    pendingFree: null,
    players: players.map((name, i) => ({
      index: i,
      name,
      hand: [],
      forest: [],      // 自己森林里的树 [{ uid, treeId, slots:{top,bottom,left,right} }]
      cave: [],        // 洞穴（背面朝下的牌，每张 1 分）
      score: 0,
    })),
  };

  // 起始手牌：每人 6 张（原版规则）
  for (const p of state.players) {
    for (let i = 0; i < 6; i++) drawFromDeck(state, p);
  }

  return state;
}

function drawFromDeck(state, player) {
  if (state.deck.length === 0) return null;
  const c = state.deck.shift();
  if (c.kind === 'winter') {
    state.winterRevealed++;
    if (state.winterRevealed >= 3) state.ended = true;
    return c;
  }
  if (player) player.hand.push(c);
  return c;
}

function drawFromClearing(state, player, index) {
  if (index < 0 || index >= state.clearing.length) return null;
  const [c] = state.clearing.splice(index, 1);
  player.hand.push(c);
  return c;
}

// ---------- 动作：抽两张 ----------
function actionDraw(state, playerIndex, picks) {
  const p = state.players[playerIndex];
  if (p.hand.length >= 10) return { ok: false, error: 'hand full' };
  const room = 10 - p.hand.length;
  const take = Math.min(2, room);
  const got = [];
  // picks: [{from:'clearing', index}] 或 {from:'deck'}
  for (let i = 0; i < take; i++) {
    const pick = picks && picks[i];
    if (pick && pick.from === 'clearing') {
      const c = drawFromClearing(state, p, pick.index);
      if (c) got.push(c);
    } else {
      const c = drawFromDeck(state, p);
      if (c) got.push(c);
    }
    if (state.ended) break;
  }
  return { ok: true, got };
}

// ---------- 动作：打一张牌 ----------
/**
 * play: {
 *   cardUid,
 *   pay: [uid, ...],                  // 用于支付的弃牌
 *   asTree: bool,                     // 背面朝下当树苗
 *   face: 0|1,                        // 双面卡选哪面
 *   treeUid, slot,                    // 挂到哪棵树的哪个槽
 *   cave: bool                        // 放入洞穴
 * }
 */
function actionPlay(state, playerIndex, play) {
  const p = state.players[playerIndex];
  const handIdx = p.hand.findIndex(c => c.uid === play.cardUid);
  if (handIdx < 0) return { ok: false, error: 'card not in hand' };
  const card = p.hand[handIdx];

  const cost = resolveCost(state, card, play);
  const payCards = (play.pay || []).map(uid => p.hand.find(c => c.uid === uid)).filter(Boolean);
  if (payCards.length < cost) return { ok: false, error: `need ${cost} to pay, got ${payCards.length}` };

  // 移除支付牌进空地
  for (const pc of payCards.slice(0, cost)) {
    const i = p.hand.indexOf(pc);
    if (i >= 0) { p.hand.splice(i, 1); state.clearing.push(pc); }
  }
  // 移除打出的牌
  p.hand.splice(p.hand.indexOf(card), 1);

  // ---------- 奖励效果（bonus）判定 ----------
  // 原版规则：支付的每一张牌都要带「匹配的叶子符号」才触发 bonus。
  // 匹配 = 该牌的任一面树符号与「打出的牌所属树的符号」相同。
  let bonusFired = false;
  let bonusEffect = null;
  {
    const playedLeaf = leafOfPlayed(state, card, play);
    if (playedLeaf && cost > 0 && payCards.length >= cost) {
      const used = payCards.slice(0, cost);
      bonusFired = used.every(pc => cardMatchesLeaf(pc, playedLeaf));
      if (bonusFired) {
        const effDef = state.effectById && state.effectById.get(playedFaceIdOf(card, play));
        const bonusStr = (effDef && effDef.bonus) || 'Effekt::Keiner';
        if (bonusStr && bonusStr !== 'Effekt::Keiner') bonusEffect = bonusStr;
      }
    }
  }

  // 放置
  if (play.cave) {
    p.cave.push(card);
  } else if (play.asTree) {
    p.forest.push({
      uid: card.uid,
      treeId: 'sapling',
      slots: { top: null, bottom: null, left: null, right: null },
    });
    // 树牌打出时翻一张进空地
    const flipped = state.deck.shift();
    if (flipped) {
      if (flipped.kind === 'winter') {
        state.winterRevealed++;
        if (state.winterRevealed >= 3) state.ended = true;
      } else state.clearing.push(flipped);
    }
  } else if (card.kind === 'tree') {
    p.forest.push({
      uid: card.uid,
      treeId: card.face,
      slots: { top: null, bottom: null, left: null, right: null },
    });
    const flipped = state.deck.shift();
    if (flipped) {
      if (flipped.kind === 'winter') {
        state.winterRevealed++;
        if (state.winterRevealed >= 3) state.ended = true;
      } else state.clearing.push(flipped);
    }
  } else {
    // 双面卡：挂到指定树的槽
    const tree = p.forest.find(t => t.uid === play.treeUid);
    if (!tree) return { ok: false, error: 'tree not found' };
    if (tree.slots[play.slot]) return { ok: false, error: 'slot occupied' };
    const faceIdx = play.face === 1 ? 1 : 0;
    tree.slots[play.slot] = {
      uid: card.uid,
      faceId: card.faces[faceIdx].id,
      hiddenFaceId: card.faces[1 - faceIdx].id,
    };
  }

  // 空地溢出
  if (state.clearing.length >= 10) state.clearing.length = 0;

  // ---------- 执行卡牌效果 ----------
  // 打出的是什么牌，就查它的 soforteffekt
  let playedFaceId = null;
  if (play.cave || play.asTree) {
    playedFaceId = null;                                  // 背面朝下 / 树苗没有效果
  } else if (card.kind === 'tree') {
    playedFaceId = card.face;
  } else {
    playedFaceId = card.faces[play.face === 1 ? 1 : 0].id;
  }

  let effectResult = { log: [], extraTurn: false, pending: [], keepTurn: false, mode: null };
  if (playedFaceId) {
    // 效果存在 spec.json（effectById），计分存在 cards.json（byId）——两者不是同一份数据
    const effDef = state.effectById && state.effectById.get(playedFaceId);
    const effStr = (effDef && effDef.immediate) || 'Effekt::Keiner';
    effectResult = effects.runImmediate(state, playerIndex, effStr, module.exports);

    // 持续效果：扫描自己森林里已有的 Dauereffekt，命中触发条件就执行
    const playTarget = (play.treeUid != null && play.slot)
      ? { treeUid: play.treeUid, slot: play.slot }
      : null;
    const persResult = effects.runPersistent(state, playerIndex, playedFaceId, playTarget, module.exports);
    effectResult.log = effectResult.log.concat(persResult.log);
    effectResult.pending = effectResult.pending.concat(persResult.pending);
    if (persResult.extraTurn) effectResult.extraTurn = true;
    if (persResult.keepTurn) effectResult.keepTurn = true;
    if (persResult.mode) effectResult.mode = persResult.mode;
  }

  // 奖励效果：支付牌全部带匹配叶子符号才执行
  if (bonusFired && bonusEffect) {
    const bonusResult = effects.runImmediate(state, playerIndex, bonusEffect, module.exports);
    effectResult.log = effectResult.log.concat(bonusResult.log);
    effectResult.pending = effectResult.pending.concat(bonusResult.pending);
    if (bonusResult.extraTurn) effectResult.extraTurn = true;
    if (bonusResult.keepTurn) effectResult.keepTurn = true;
    if (bonusResult.mode) effectResult.mode = bonusResult.mode;
  }

  // 把「需要玩家选择」的效果落成可结算额度（免费放置 / 空地取牌）
  applyPending(state, effectResult);

  return {
    ok: true,
    play: play,
    playedFaceId,
    effect: effectResult,
    extraTurn: effectResult.extraTurn,
    keepTurn: !!effectResult.keepTurn,
    mode: effectResult.mode || null,
    bonusFired: !!bonusFired,
    bonusEffect: bonusEffect || null,
    paidLeaf: leafOfPlayed(state, card, play),
  };
}

// ---------- 动作：免费放置（EinsKostenlosAblegen 系列结算） ----------
/**
 * 原版规则：免费放置不付费，但不得触发该牌的效果与奖励。
 * spec: { cardUid, treeUid, slot, asTree, face }
 */
function actionPlayFree(state, playerIndex, spec) {
  const p = state.players[playerIndex];
  const q = state.pendingFree;
  if (!q) return { ok: false, error: 'no free play pending' };
  if (q.remaining <= 0) return { ok: false, error: 'free play used up' };

  const handIdx = p.hand.findIndex(c => c.uid === spec.cardUid);
  if (handIdx < 0) return { ok: false, error: 'card not in hand' };
  const card = p.hand[handIdx];

  // 类型 / 名称约束校验（先校验后落子，避免校验失败时手牌已被移走）
  if (q.kind === 'typed') {
    const fi = spec.face === 1 ? 1 : 0;
    const faceId = card.kind === 'tree' ? card.face
      : (card.kind === 'split' ? card.faces[fi].id : null);
    const types = effects.typesOf(state, faceId);
    const okType = (q.types || []).some(t => types.includes(t));
    const okName = (q.names || []).includes(faceId);
    if (!okType && !okName) return { ok: false, error: 'card does not match free play type' };
  }

  // 放置目标校验
  let targetTree = null;
  const asTree = !!spec.asTree || card.kind === 'tree';
  if (!asTree) {
    if (card.kind !== 'split') return { ok: false, error: 'cannot place card' };
    targetTree = p.forest.find(t => t.uid === spec.treeUid);
    if (!targetTree) return { ok: false, error: 'tree not found' };
    if (targetTree.slots[spec.slot]) return { ok: false, error: 'slot occupied' };
  }

  // 落子
  p.hand.splice(handIdx, 1);
  let placed;
  if (asTree) {
    p.forest.push({
      uid: card.uid,
      treeId: card.kind === 'tree' ? card.face : 'sapling',
      slots: { top: null, bottom: null, left: null, right: null },
    });
    placed = { as: 'tree' };
  } else {
    const fi = spec.face === 1 ? 1 : 0;
    targetTree.slots[spec.slot] = {
      uid: card.uid,
      faceId: card.faces[fi].id,
      hiddenFaceId: card.faces[1 - fi].id,
    };
    placed = { as: 'slot', treeUid: targetTree.uid, slot: spec.slot };
  }

  if (q.remaining !== 99) q.remaining--;
  if (q.remaining <= 0) state.pendingFree = null;
  return { ok: true, placed, remaining: q.remaining, paid: 0 };
}

// ---------- 动作：从空地取指定类型牌入手（LichtungHandTyp 结算） ----------
function actionTakeClearing(state, playerIndex, uid) {
  const p = state.players[playerIndex];
  const q = state.pendingFree;
  if (!q || q.kind !== 'clearing') return { ok: false, error: 'no clearing pick pending' };
  if (p.hand.length >= 10) return { ok: false, error: 'hand full' };
  const idx = state.clearing.findIndex(c => c.uid === uid);
  if (idx < 0) return { ok: false, error: 'card not in clearing' };
  const card = state.clearing[idx];
  const def = state.byId.get(effects.cardIdOf(card));
  const types = (def && def.symbols) || [];
  if (!(q.types || []).some(t => types.includes(t))) {
    return { ok: false, error: 'card does not match required type' };
  }
  state.clearing.splice(idx, 1);
  p.hand.push(card);
  state.pendingFree = null;
  return { ok: true, card: { uid: card.uid, kind: card.kind } };
}

/**
 * 把效果返回的 pending 落成可结算额度，并记录保留回合模式。
 * 这是「效果 → 玩家选择 → 结算」链路的中转站。
 */
function applyPending(state, effectResult) {
  for (const item of (effectResult.pending || [])) {
    if (item.kind === 'freePlayOne') {
      state.pendingFree = { kind: 'typed', types: [item.effect.type], names: [], remaining: 1 };
    } else if (item.kind === 'freePlayOneName') {
      state.pendingFree = { kind: 'typed', types: [], names: [item.effect.name], remaining: 1 };
    } else if (item.kind === 'freePlayOne2x') {
      state.pendingFree = { kind: 'typed', types: item.effect.types, names: [], remaining: 2 };
    } else if (item.kind === 'freePlayAny') {
      state.pendingFree = { kind: 'typed', types: [item.effect.type], names: [], remaining: 99 };
    } else if (item.kind === 'clearingToHandType') {
      state.pendingFree = {
        kind: 'clearing', types: [item.effect.type], names: [],
        options: item.options || [], remaining: 1,
      };
    }
  }
  if (effectResult.keepTurn) state.turnMode = effectResult.mode || 'keep';
}

/** 打出这张牌时，它的「叶子符号」是哪个树种 */function leafOfPlayed(state, card, play) {
  if (play.cave || play.asTree) return null;
  if (card.kind === 'tree') return card.leaf || card.face;
  if (card.kind === 'split') {
    const f = play.face === 1 ? card.faces[1] : card.faces[0];
    return f ? f.tree : null;
  }
  return null;
}

/** 打出的牌面 id（用于查效果表） */
function playedFaceIdOf(card, play) {
  if (play.cave || play.asTree) return null;
  if (card.kind === 'tree') return card.face;
  if (card.kind === 'split') {
    const f = play.face === 1 ? card.faces[1] : card.faces[0];
    return f ? f.id : null;
  }
  return null;
}

/** 这张支付牌是否带指定叶子符号（双面卡任一面匹配即可，原版规则） */
function cardMatchesLeaf(card, leaf) {
  if (!card || !leaf) return false;
  if (card.kind === 'tree') return (card.leaf || card.face) === leaf;
  if (card.kind === 'split') return card.leafA === leaf || card.leafB === leaf;
  return false;
}

/**
 * 费用解析。
 * 注意：cards.json（byId）只有计分规则，没有 cost 字段；
 * 费用存在 spec.json 的 cards[].cost，运行时索引在 state.effectById。
 */
function resolveCost(state, card, play) {
  if (play.cave) return 0;        // 放洞穴不付费
  if (play.asTree) return 0;      // 背面朝下当树苗不付费

  let faceId = null;
  if (card.kind === 'tree') {
    faceId = card.face;
  } else if (card.kind === 'split') {
    faceId = play.face === 1 ? card.faces[1].id : card.faces[0].id;
  }
  if (!faceId) return 0;

  const eff = state.effectById && state.effectById.get(faceId);
  if (eff && eff.cost != null) return Number(eff.cost) || 0;

  // 兜底：万一 spec 里没有这张牌，退回 byId（可能也缺，那就 0）
  const def = state.byId.get(faceId);
  return def && def.cost != null ? Number(def.cost) || 0 : 0;
}

// ---------- 计分 ----------
/**
 * 计分求值器：支持 4 种 reward 模式 × 7 种 count 维度
 *   count.of: self | symbol | distinct | attachedCards | condition | tag | zone
 *   reward.mode: perUnit | threshold | lookup | flat
 */
function scorePlayer(state, playerIndex) {
  const p = state.players[playerIndex];
  const all = collectVisibleCards(p, state.byId);

  const counts = {
    self: {},
    symbol: {},
    tag: {},
    zone: {},
  };
  for (const v of all) {
    counts.self[v.faceId] = (counts.self[v.faceId] || 0) + 1;
    for (const s of v.symbols || []) counts.symbol[s] = (counts.symbol[s] || 0) + 1;
    for (const t of v.tags || []) counts.tag[t] = (counts.tag[t] || 0) + 1;
    if (v.zone) counts.zone[v.zone] = (counts.zone[v.zone] || 0) + 1;
  }

  let total = 0;
  const detail = [];

  for (const v of all) {
    const def = state.byId.get(v.faceId);
    if (!def || !def.scoring) continue;
    let cardPts = 0;
    for (const rule of def.scoring) {
      cardPts += evalRule(rule, v, counts, all, state);
    }
    if (cardPts) detail.push({ id: v.faceId, pts: cardPts });
    total += cardPts;
  }

  total += p.cave.length;   // 洞穴每张 1 分
  return { total, detail };
}

/**
 * 收集玩家林中「可见」的卡：树本体 + 每个槽位上露出的那一面。
 * 必须带上 symbols / tags / zone，否则计分的 symbol/tag/zone 维度全为 0。
 */
function collectVisibleCards(player, byId) {
  const out = [];
  for (const tree of player.forest) {
    // 树本体
    const tdef = byId.get(tree.treeId);
    out.push({
      faceId: tree.treeId,
      treeUid: tree.uid,
      slot: null,
      isTree: true,
      symbols: (tdef && tdef.symbols) || [],
      tags: (tdef && tdef.tags) || [],
      zone: (tdef && tdef.zone) || null,
      category: (tdef && tdef.category) || null,
    });
    // 四个槽位上可见的一面
    for (const slot of ['top', 'bottom', 'left', 'right']) {
      const s = tree.slots[slot];
      if (!s) continue;
      const def = byId.get(s.faceId);
      out.push({
        faceId: s.faceId,
        treeUid: tree.uid,
        slot,
        isTree: false,
        symbols: (def && def.symbols) || [],
        tags: (def && def.tags) || [],
        zone: (def && def.zone) || null,
        category: (def && def.category) || null,
      });
    }
  }
  return out;
}

function evalRule(rule, self, counts, all, state) {
  const def = state.byId.get(self.faceId);
  const count = rule.count || {};
  const reward = rule.reward || {};

  let n = 0;
  switch (count.of) {
    case 'self':
      n = counts.self[self.faceId] || 0;
      break;
    case 'symbol':
      n = counts.symbol[count.value] || 0;
      break;
    case 'tag':
      n = counts.tag[count.value] || 0;
      break;
    case 'zone':
      n = counts.zone[count.value] || 0;
      break;
    case 'distinct': {
      // 不同种类的数量（按 symbol 去重）
      const seen = new Set();
      for (const v of all) if ((v.symbols || []).includes(count.value)) seen.add(v.faceId);
      n = seen.size;
      break;
    }
    case 'attachedCards': {
      // 挂在这张牌所在树上的其他卡数
      const tree = all.find(t => t.treeUid === self.treeUid && !t.slot);
      n = all.filter(t => t.treeUid === self.treeUid && t.slot).length;
      break;
    }
    case 'condition':
      n = count.value === 'mostTreesNoTies' ? 0 : 0;   // 需要全局比较，单独处理
      break;
    default:
      n = 0;
  }

  switch (reward.mode) {
    case 'perUnit':
      return n * (reward.points || 0);
    case 'flat':
      return reward.points || 0;
    case 'threshold':
      return n >= (reward.minimum || 0) ? (reward.points || 0) : 0;
    case 'lookup': {
      const t = reward.table || [];
      const i = Math.min(n, t.length - 1);
      return i >= 0 ? (t[i] || 0) : 0;
    }
    default:
      return 0;
  }
}

// ---------- 导出 ----------
module.exports = {
  loadCards,
  buildDeck,
  createGame,
  actionDraw,
  actionPlay,
  actionPlayFree,
  actionTakeClearing,
  applyPending,
  scorePlayer,
  drawFromDeck,
  drawFromClearing,
  makeRng,
  shuffle,
  collectVisibleCards,
};