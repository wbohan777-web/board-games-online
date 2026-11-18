'use strict';
/**
 * Forest Shuffle 卡牌效果执行器
 *
 * 效果来自 Rust 源（soforteffekt / bonus），已归类为：
 *   抽牌类    KartenZiehen(n) / KartenZiehenAnzTyp / KartenZiehenAnzName / KartenZiehenLichtung
 *   空地类    LichtungHoehle(n) / LichtungHoehleTypen / LichtungLeeren
 *   回合类    Extrazug（额外回合）
 *   免费放置  EinsKostenlosAblegen(typ) / BeliebigKostenlosAblegen(typ) / BeliebigSprösslingeAusspielen
 *   条件类    Bedingung(...)
 *
 * 奖励效果（bonus）只有当支付牌全部带有匹配的叶子符号时触发。
 */

// 德语类型 → 游戏内 symbol
const TYPE_MAP = {
  Pfotentier: 'pawedAnimal',
  Fledermaus: 'bat',
  Hirsch: 'deer',
  Paarhufer: 'clovenHoofedAnimal',
  Vogel: 'bird',
  Schmetterling: 'butterfly',
  Insekt: 'insect',
  Pflanze: 'plant',
  Pilz: 'mushroom',
  Amphibie: 'amphibian',
  Strauch: 'shrub',
  Baum: 'tree',
  Alpen: 'alpine',
};
const mapType = t => TYPE_MAP[t] || t;

// ---------- 解析效果串 ----------
function parseEffect(str) {
  if (!str || str === 'Effekt::Keiner' || str === 'Dauereffekt::Keiner') {
    return { kind: 'none' };
  }
  const s = str.replace(/^Effekt::/, '');

  let m = s.match(/^KartenZiehen\((\d+)\)$/);
  if (m) return { kind: 'draw', n: Number(m[1]) };

  m = s.match(/^KartenZiehenAnzTyp\(Typsymbol::(\w+)\)$/);
  if (m) return { kind: 'drawByType', type: mapType(m[1]) };

  m = s.match(/^KartenZiehenAnzName\("([^"]+)"\)$/);
  if (m) return { kind: 'drawByName', name: m[1] };

  m = s.match(/^KartenZiehenLichtung\((\d+)\)$/);
  if (m) return { kind: 'drawClearing', n: Number(m[1]) };

  m = s.match(/^LichtungH(?:ö|oe)hle\((\d+)\)$/);
  if (m) return { kind: 'clearingToCave', n: Number(m[1]) };

  m = s.match(/^LichtungH(?:ö|oe)hleTypen\(&\[([^\]]+)\]\)$/);
  if (m) return { kind: 'clearingToCaveTypes', types: m[1].split(',').map(x => mapType(x.trim())) };

  if (s === 'LichtungLeeren') return { kind: 'clearClearing' };
  if (s === 'Extrazug') return { kind: 'extraTurn' };

  m = s.match(/^EinsKostenlosAblegen\((\w+)\)$/);
  if (m) return { kind: 'freePlayOne', type: mapType(m[1]) };

  m = s.match(/^EinsKostenlosAblegenName\("([^"]+)"\)$/);
  if (m) return { kind: 'freePlayOneName', name: m[1] };

  m = s.match(/^EinsKostenlosAblegen2x\(([^)]+)\)$/);
  if (m) return { kind: 'freePlayOne2x', types: m[1].split(',').map(x => mapType(x.trim())) };

  m = s.match(/^BeliebigKostenlosAblegen\((\w+)\)$/);
  if (m) return { kind: 'freePlayAny', type: mapType(m[1]) };

  if (/^BeliebigSpr(?:ö|oe)sslingeAusspielen$/.test(s)) return { kind: 'playAnySaplings' };
  if (s === 'BeliebigKartenKostenpflichtigSpielen') return { kind: 'playAnyPaid' };

  m = s.match(/^LichtungHandTyp\((\w+)\)$/);
  if (m) return { kind: 'clearingToHandType', type: mapType(m[1]) };

  // Bedingung(<条件>, <内嵌效果>)
  const cond = parseBedingung(s);
  if (cond) return cond;

  return { kind: 'unsupported', raw: s };
}

/**
 * 解析 Bedingung(<cond>, <inner>)。
 * Rust: Effekt::Bedingung(&Effekt, Bedingung) —— 条件为真时执行内嵌效果。
 * spec 里出现的条件形式：MinAnzTyp(n, Typ)
 */
function parseBedingung(s) {
  const m = s.match(/^Bedingung\((.+)\)$/);
  if (!m) return null;
  const body = m[1];
  // 在内层切分：条件在前，效果在后。条件以已知条件名开头。
  const condNames = ['MeisteNamen', 'MeisteAnzTyp', 'MinAnzNamen', 'MinAnzTypVerschieden',
                     'MinAnzTyp', 'TypGegenüber', 'MinAnzNamenAnPlatz', 'Hauptpflanzenname',
                     'Hauptpflanzentyp'];
  const head = condNames.find(n => body.startsWith(n + '('));
  if (!head) return null;
  // 找到条件参数的结束括号（考虑嵌套）
  let depth = 0, i = head.length;
  for (; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  const condStr = body.slice(0, i);
  const rest = body.slice(i).replace(/^,\s*/, '');
  if (!rest) return null;

  return {
    kind: 'conditional',
    condition: parseCondition(condStr),
    effect: rest,
  };
}

/** 只实现 spec 中实际出现的条件形式，其余记为 unsupported-cond 便于审计 */
function parseCondition(str) {
  let m = str.match(/^MinAnzTyp\((\d+),\s*(\w+)\)$/);
  if (m) return { kind: 'minCountType', min: Number(m[1]), type: mapType(m[2]) };

  m = str.match(/^MinAnzTypVerschieden\((\d+),\s*(\w+)\)$/);
  if (m) return { kind: 'minDistinctType', min: Number(m[1]), type: mapType(m[2]) };

  m = str.match(/^MinAnzNamen\((\d+),\s*"([^"]+)"\)$/);
  if (m) return { kind: 'minCountName', min: Number(m[1]), name: m[2] };

  m = str.match(/^Hauptpflanzentyp\(&\[([^\]]+)\]\)$/);
  if (m) return { kind: 'hostType', types: m[1].split(',').map(x => mapType(x.trim())) };

  m = str.match(/^Hauptpflanzenname\("([^"]+)"\)$/);
  if (m) return { kind: 'hostName', name: m[1] };

  return { kind: 'unsupportedCond', raw: str };
}

/**
 * 解析 Dauereffekt（持续效果）。
 *   BeiKarteAusspielenTyp(Typ, Effekt)                 打出某类型牌时触发
 *   BeiKarteAusspielenPositionTyp(Pos, Typ, Effekt)    在某类型主植物某位置放置时触发
 */
function parsePersistent(str) {
  if (!str || str === 'Dauereffekt::Keiner') return { kind: 'none' };

  let m = str.match(/^Dauereffekt::BeiKarteAusspielenTyp\(\s*(\w+)\s*,\s*(.+)\)$/);
  if (m) return { kind: 'onPlayType', type: mapType(m[1]), effect: m[2] };

  m = str.match(/^Dauereffekt::BeiKarteAusspielenPositionTyp\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(.+)\)$/);
  if (m) return { kind: 'onPlayPosition', position: positionOf(m[1]), hostType: mapType(m[2]), effect: m[3] };

  return { kind: 'unsupported', raw: str };
}

const POSITION_MAP = { Oben: 'top', Unten: 'bottom', Links: 'left', Rechts: 'right' };
const positionOf = p => POSITION_MAP[p] || p;

// ---------- 执行 ----------
/**
 * 立即效果：在牌被打出、放置完成后执行。
 * 返回 { log: string[], extraTurn: bool, pending: [...] }
 */
function runImmediate(state, playerIndex, effectStr, engine) {
  const eff = parseEffect(effectStr);
  const p = state.players[playerIndex];
  const log = [];
  let extraTurn = false;
  let keepTurn = false;      // 保留回合（可继续出牌）
  let mode = null;           // 'saplings' | 'anyPaid'
  const pending = [];

  switch (eff.kind) {
    case 'none':
    case 'unsupported':
      break;

    case 'draw': {
      let got = 0;
      for (let i = 0; i < eff.n; i++) {
        if (p.hand.length >= 10) break;
        const c = engine.drawFromDeck(state, p);
        if (c) got++;
        if (state.ended) break;
      }
      if (got) log.push(`ドロー ${got}`);
      break;
    }

    case 'drawByType': {
      const n = countSymbol(p, state, eff.type);
      for (let i = 0; i < n; i++) {
        if (p.hand.length >= 10) break;
        engine.drawFromDeck(state, p);
        if (state.ended) break;
      }
      if (n) log.push(`ドロー ${n}（按 ${eff.type} 数量）`);
      break;
    }

    case 'drawByName': {
      const n = countName(p, state, eff.name);
      for (let i = 0; i < n; i++) {
        if (p.hand.length >= 10) break;
        engine.drawFromDeck(state, p);
        if (state.ended) break;
      }
      if (n) log.push(`ドロー ${n}（按 ${eff.name} 数量）`);
      break;
    }

    case 'drawClearing': {
      let got = 0;
      for (let i = 0; i < eff.n && state.clearing.length > 0; i++) {
        if (p.hand.length >= 10) break;
        const c = state.clearing.shift();
        if (c) { p.hand.push(c); got++; }
      }
      if (got) log.push(`从空地抽 ${got}`);
      break;
    }

    case 'clearingToCave': {
      let moved = 0;
      for (let i = 0; i < eff.n && state.clearing.length > 0; i++) {
        p.cave.push(state.clearing.pop());
        moved++;
      }
      if (moved) log.push(`空地 ${moved} 张进洞穴`);
      break;
    }

    case 'clearingToCaveTypes': {
      let moved = 0;
      for (let i = state.clearing.length - 1; i >= 0; i--) {
        const c = state.clearing[i];
        const def = state.byId.get(cardIdOf(c));
        if (!def) continue;
        const hit = (def.symbols || []).some(s => eff.types.includes(s));
        if (hit) { p.cave.push(state.clearing.splice(i, 1)[0]); moved++; }
      }
      if (moved) log.push(`空地 ${moved} 张对应类型进洞穴`);
      break;
    }

    case 'clearClearing': {
      const n = state.clearing.length;
      state.clearing.length = 0;
      if (n) log.push(`清空空地 ${n} 张`);
      break;
    }

    case 'extraTurn':
      extraTurn = true;
      log.push('额外回合');
      break;

    case 'freePlayOne':
    case 'freePlayOneName':
    case 'freePlayOne2x':
    case 'freePlayAny':
      // 需要玩家选一张手牌免费放置，交给前端/服务端后续 playFree 动作结算
      pending.push({ kind: eff.kind, effect: eff });
      break;

    case 'playAnySaplings':
      // 本回合可把手牌任意多张当树苗背面打出（免费），保留回合
      keepTurn = true;
      mode = 'saplings';
      log.push('可任意放置树苗');
      break;

    case 'playAnyPaid':
      // 本回合可付任意多张牌（费用照付），保留回合
      keepTurn = true;
      mode = 'anyPaid';
      log.push('可付费连续出牌');
      break;

    case 'clearingToHandType': {
      const take = state.clearing.filter(c => {
        const d = state.byId.get(cardIdOf(c));
        return d && (d.symbols || []).includes(eff.type);
      });
      if (take.length) pending.push({ kind: 'clearingToHandType', effect: eff, options: take.map(c => c.uid) });
      break;
    }

    case 'conditional': {
      if (eff.condition && eff.condition.kind !== 'unsupportedCond' &&
          evalCondition(state, playerIndex, eff.condition)) {
        const inner = runImmediate(state, playerIndex, eff.effect, engine);
        log.push('条件满足');
        log.push(...inner.log);
        pending.push(...inner.pending);
        if (inner.extraTurn) extraTurn = true;
        if (inner.keepTurn) keepTurn = true;
        if (inner.mode) mode = inner.mode;
      } else {
        log.push('条件不满足');
      }
      break;
    }
  }

  return { log, extraTurn, pending, keepTurn, mode };
}

/**
 * 条件判定。spec 中实际出现的条件形式都已覆盖；
 * 需要「主植物上下文」的条件在其上下文缺失时返回 false。
 */
function evalCondition(state, playerIndex, cond) {
  const p = state.players[playerIndex];
  switch (cond.kind) {
    case 'minCountType':
      return countSymbol(p, state, cond.type) >= cond.min;
    case 'minDistinctType': {
      const seen = new Set();
      for (const t of p.forest) {
        const td = state.byId.get(t.treeId);
        if (td && (td.symbols || []).includes(cond.type)) seen.add(t.treeId);
        for (const slot of ['top', 'bottom', 'left', 'right']) {
          const s = t.slots[slot];
          if (!s) continue;
          const d = state.byId.get(s.faceId);
          if (d && (d.symbols || []).includes(cond.type)) seen.add(s.faceId);
        }
      }
      return seen.size >= cond.min;
    }
    case 'minCountName':
      return countName(p, state, cond.name) >= cond.min;
    default:
      return false;    // hostType / hostName 需要具体主植物上下文，当前调用点没有
  }
}

/** 打出某张牌时，扫描森林里所有持续效果并触发 */
function runPersistent(state, playerIndex, playedFaceId, playTarget, engine) {
  const p = state.players[playerIndex];
  const log = [];
  let extraTurn = false;
  let keepTurn = false;
  let mode = null;
  const pending = [];
  const playedTypes = typesOf(state, playedFaceId);
  if (!playedTypes.length) return { log, extraTurn, pending, keepTurn, mode };

  for (const tree of p.forest) {
    // 树本体 + 四个槽位的可见面都可能带持续效果
    const holders = [{ faceId: tree.treeId, slot: null }];
    for (const slot of ['top', 'bottom', 'left', 'right']) {
      const s = tree.slots[slot];
      if (s) holders.push({ faceId: s.faceId, slot });
    }
    for (const h of holders) {
      const effDef = state.effectById && state.effectById.get(h.faceId);
      if (!effDef || !effDef.persistent) continue;
      const pers = parsePersistent(effDef.persistent);
      if (pers.kind === 'none' || pers.kind === 'unsupported') continue;

      let fire = false;
      if (pers.kind === 'onPlayType') {
        fire = playedTypes.includes(pers.type);
      } else if (pers.kind === 'onPlayPosition') {
        // 打出的牌挂在这棵树上、槽位匹配、且主植物类型匹配
        fire = !!playTarget && playTarget.treeUid === tree.uid &&
               playTarget.slot === pers.position &&
               typesOf(state, tree.treeId).includes(pers.hostType);
      }
      if (!fire) continue;

      const r = runImmediate(state, playerIndex, pers.effect, engine);
      if (r.log.length) log.push(...r.log);
      pending.push(...r.pending);
      if (r.extraTurn) extraTurn = true;
      if (r.keepTurn) keepTurn = true;
      if (r.mode) mode = r.mode;
    }
  }

  return { log, extraTurn, pending, keepTurn, mode };
}

/** 从效果索引取一张牌的类型（英文符号） */
function typesOf(state, faceId) {
  if (!faceId) return [];
  const e = state.effectById && state.effectById.get(faceId);
  if (e && Array.isArray(e.types)) return e.types;
  const def = state.byId && state.byId.get(faceId);
  return (def && def.symbols) || [];
}

function cardIdOf(c) {
  if (!c) return null;
  if (c.kind === 'tree') return c.face;
  if (c.kind === 'split') return c.faces[0].id;
  return null;
}

function countSymbol(p, state, symbol) {
  let n = 0;
  for (const t of p.forest) {
    const td = state.byId.get(t.treeId);
    if (td && (td.symbols || []).includes(symbol)) n++;
    for (const slot of ['top', 'bottom', 'left', 'right']) {
      const s = t.slots[slot];
      if (!s) continue;
      const d = state.byId.get(s.faceId);
      if (d && (d.symbols || []).includes(symbol)) n++;
    }
  }
  return n;
}

function countName(p, state, name) {
  let n = 0;
  for (const t of p.forest) {
    if (t.treeId === name) n++;
    for (const slot of ['top', 'bottom', 'left', 'right']) {
      const s = t.slots[slot];
      if (s && s.faceId === name) n++;
    }
  }
  return n;
}

module.exports = {
  parseEffect, runImmediate, mapType, countSymbol, countName, cardIdOf,
  parseBedingung, parseCondition, parsePersistent, evalCondition,
  runPersistent, typesOf, POSITION_MAP,
};