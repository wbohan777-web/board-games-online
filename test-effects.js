'use strict';
/**
 * 效果层确定性断言：覆盖 spec.json 全部 27 种 immediate/bonus 串与 8 张持续效果。
 * 不依赖随机牌堆——直接构造最小状态，逐类验证解析与执行。
 */
const path = require('path');
const E = require(path.join(__dirname, 'forest-shuffle', 'effects.js'));
const F = require(path.join(__dirname, 'forest-shuffle', 'engine.js'));

const pass = [], fail = [];
const ok = (n, c) => (c ? pass : fail).push(n);
const eq = (n, a, b) => ok(n + '（' + a + ' === ' + b + '）', a === b);

// ---------- 1. 解析器：27 种串全部有处理器 ----------
const spec = require(path.join(__dirname, 'forest-shuffle', 'spec.json'));
const strings = new Set();
for (const g of ['base', 'alpine', 'woodland']) {
  for (const c of (spec.cards[g] || [])) {
    for (const f of ['immediate', 'bonus']) {
      const v = c[f];
      if (v && v !== 'Effekt::Keiner') strings.add(f + '|' + v);
    }
  }
}
ok('spec 里 immediate+bonus 共 27 种（按字段+串计）', strings.size === 27);
let unsupported = 0;
for (const s of strings) if (E.parseEffect(s.split('|')[1]).kind === 'unsupported') unsupported++;
eq('无 unsupported 效果串', unsupported, 0);

// 逐类抽样确认解析正确
eq('KartenZiehen(1) 解析', E.parseEffect('Effekt::KartenZiehen(1)').kind, 'draw');
eq('KartenZiehen(2) 数量', E.parseEffect('Effekt::KartenZiehen(2)').n, 2);
eq('AnzTyp 解析为 deer', E.parseEffect('Effekt::KartenZiehenAnzTyp(Typsymbol::Hirsch)').type, 'deer');
eq('AnzName 解析出名字', E.parseEffect('Effekt::KartenZiehenAnzName("Feldhase")').name, 'Feldhase');
eq('Extrazug 解析', E.parseEffect('Effekt::Extrazug').kind, 'extraTurn');
eq('LichtungHöhle(2) 数量', E.parseEffect('Effekt::LichtungHöhle(2)').n, 2);
eq('LichtungLeeren 解析', E.parseEffect('Effekt::LichtungLeeren').kind, 'clearClearing');
eq('Sprösslinge 不再落 unsupported',
   E.parseEffect('Effekt::BeliebigSprösslingeAusspielen').kind, 'playAnySaplings');
eq('Kostenpflichtig 解析', E.parseEffect('Effekt::BeliebigKartenKostenpflichtigSpielen').kind, 'playAnyPaid');
eq('EinsKostenlosAblegen(Pflanze) 类型',
   E.parseEffect('Effekt::EinsKostenlosAblegen(Pflanze)').type, 'plant');
eq('EinsKostenlosAblegen2x 双类型',
   E.parseEffect('Effekt::EinsKostenlosAblegen2x(Alpen, Insekt)').types.join('+'), 'alpine+insect');
eq('LichtungHandTyp 解析', E.parseEffect('Effekt::LichtungHandTyp(Fledermaus)').type, 'bat');

// ---------- 2. 条件效果（barnOwl） ----------
const barn = E.parseEffect('Effekt::Bedingung(MinAnzTyp(1, Fledermaus), Effekt::Extrazug)');
eq('Bedingung 解析为 conditional', barn.kind, 'conditional');
eq('条件类型 minCountType', barn.condition.kind, 'minCountType');
eq('条件要求 1 张蝙蝠', barn.condition.min, 1);
eq('条件符号为 bat', barn.condition.type, 'bat');
eq('内嵌效果为 Extrazug', barn.effect, 'Effekt::Extrazug');

// ---------- 3. 持续效果解析（8 张） ----------
const pers = {
  chanterelle:     ['onPlayType', 'tree'],
  flyAgaric:       ['onPlayType', 'pawedAnimal'],
  blackTrumpet:    ['onPlayType', 'alpine'],
  blackthorn:      ['onPlayType', 'butterfly'],
  commonHazel:     ['onPlayType', 'bat'],
  elderberry:      ['onPlayType', 'plant'],
  parasolMushroom: ['onPlayPosition', 'bottom'],
  pennyBun:        ['onPlayPosition', 'bottom'],
};
const byIdent = new Map();
for (const g of ['base', 'alpine', 'woodland'])
  for (const c of (spec.cards[g] || [])) byIdent.set(c.ident, c);

let persOk = 0;
for (const [ident, [kind, arg]] of Object.entries(pers)) {
  const card = byIdent.get(ident);
  const p = E.parsePersistent(card.persistent);
  const good = kind === 'onPlayType'
    ? (p.kind === 'onPlayType' && p.type === arg)
    : (p.kind === 'onPlayPosition' && p.position === arg && p.hostType === 'tree');
  if (good) persOk++;
  ok('持续效果 ' + ident + ' 解析为 ' + kind + '/' + arg, good);
}
eq('8 张持续效果全部解析成功', persOk, 8);

// 位置条件的两张蘑菇还要求主植物是 Baum
const pm = E.parsePersistent(byIdent.get('parasolMushroom').persistent);
eq('Parasol 主植物类型为 tree', pm.hostType, 'tree');
eq('Parasol 内嵌效果为抽 1', E.parseEffect(pm.effect).kind, 'draw');

// ---------- 4. 执行：条件效果正向/反向 ----------
function mkState(extra) {
  const st = F.createGame({ players: ['A', 'B'], seed: 42 });
  st.players.forEach(p => { p.hand.length = 0; p.forest.length = 0; });
  return Object.assign(st, extra || {});
}

// 反向：森林里没有蝙蝠 → 不触发额外回合
const stA = mkState();
const rA = E.runImmediate(stA, 0, 'Effekt::Bedingung(MinAnzTyp(1, Fledermaus), Effekt::Extrazug)', F);
ok('无蝙蝠时条件不满足', rA.extraTurn === false);
ok('无蝙蝠时日志含「条件不满足」', rA.log.includes('条件不满足'));

// 正向：森林里放一张蝙蝠 → 触发额外回合
const stB = mkState();
stB.players[0].forest.push({
  uid: 1, treeId: 'bechsteinsBat', slots: { top: null, bottom: null, left: null, right: null },
});
const rB = E.runImmediate(stB, 0, 'Effekt::Bedingung(MinAnzTyp(1, Fledermaus), Effekt::Extrazug)', F);
ok('有蝙蝠时条件满足', rB.extraTurn === true);
ok('有蝙蝠时日志含「额外回合」', rB.log.includes('额外回合'));

// ---------- 5. 执行：持续效果触发 ----------
// Pfifferling（chanterelle）在森林里，打出树牌 → 抽 1
const stC = mkState();
stC.players[0].forest.push({
  uid: 2, treeId: 'chanterelle', slots: { top: null, bottom: null, left: null, right: null },
});
const handBefore = stC.players[0].hand.length;
const rC = E.runPersistent(stC, 0, 'douglasFir', null, F);
eq('Pfifferling 打出树牌抽 1', stC.players[0].hand.length - handBefore, 1);
ok('Pfifferling 触发有日志', rC.log.some(x => /ドロー/.test(x)));

// 打出非树牌 → 不触发
const stD = mkState();
stD.players[0].forest.push({
  uid: 3, treeId: 'chanterelle', slots: { top: null, bottom: null, left: null, right: null },
});
const hD = stD.players[0].hand.length;
E.runPersistent(stD, 0, 'europeanBadger', null, F);
eq('Pfifferling 打出非树牌不抽', stD.players[0].hand.length - hD, 0);

// Fliegenpilz（flyAgaric）打 Pfotentier → 抽 1
const stE = mkState();
stE.players[0].forest.push({
  uid: 4, treeId: 'flyAgaric', slots: { top: null, bottom: null, left: null, right: null },
});
const hE = stE.players[0].hand.length;
E.runPersistent(stE, 0, 'europeanBadger', null, F);
eq('Fliegenpilz 打出 Pfotentier 抽 1', stE.players[0].hand.length - hE, 1);

// Parasol：在 Baum 主植物下方放置 → 抽 1
const stF = mkState();
stF.players[0].forest.push({
  uid: 10, treeId: 'birch', slots: { top: null, bottom: null, left: null, right: null },
});
stF.players[0].forest[0].slots.bottom = {
  uid: 11, faceId: 'parasolMushroom', hiddenFaceId: 'x',
};
const hF = stF.players[0].hand.length;
E.runPersistent(stF, 0, 'europeanBadger', { treeUid: 10, slot: 'bottom' }, F);
eq('Parasol 下方放置抽 1', stF.players[0].hand.length - hF, 1);

// Parasol：放在上方 → 不触发
const stG = mkState();
stG.players[0].forest.push({
  uid: 12, treeId: 'birch', slots: { top: null, bottom: null, left: null, right: null },
});
stG.players[0].forest[0].slots.bottom = { uid: 13, faceId: 'parasolMushroom', hiddenFaceId: 'x' };
const hG = stG.players[0].hand.length;
E.runPersistent(stG, 0, 'europeanBadger', { treeUid: 12, slot: 'top' }, F);
eq('Parasol 上方放置不抽', stG.players[0].hand.length - hG, 0);

// ---------- 6. 执行：其余效果类 ----------
const stH = mkState();
stH.clearing = [{ uid: 50, kind: 'tree', face: 'birch' }, { uid: 51, kind: 'tree', face: 'beech' }];
E.runImmediate(stH, 0, 'Effekt::LichtungLeeren', F);
eq('LichtungLeeren 清空空地', stH.clearing.length, 0);

const stI = mkState();
stI.clearing = [{ uid: 60, kind: 'tree', face: 'birch' }];
E.runImmediate(stI, 0, 'Effekt::LichtungHöhle(2)', F);
eq('LichtungHöhle(2) 进洞穴', stI.players[0].cave.length, 1);
eq('LichtungHöhle 后空地清空', stI.clearing.length, 0);

const stJ = mkState();
stJ.clearing = [{ uid: 70, kind: 'tree', face: 'birch' }];
const rJ = E.runImmediate(stJ, 0, 'Effekt::KartenZiehenLichtung(1)', F);
eq('KartenZiehenLichtung 从空地取 1', stJ.players[0].hand.length, 1);
ok('KartenZiehenLichtung 有日志', rJ.log.length > 0);

const stK = mkState();
const rK = E.runImmediate(stK, 0, 'Effekt::BeliebigSprösslingeAusspielen', F);
ok('Sprösslinge 保留回合', rK.keepTurn === true);
eq('Sprösslinge 模式', rK.mode, 'saplings');

const stL = mkState();
const rL = E.runImmediate(stL, 0, 'Effekt::BeliebigKartenKostenpflichtigSpielen', F);
ok('Kostenpflichtig 保留回合', rL.keepTurn === true);
eq('Kostenpflichtig 模式', rL.mode, 'anyPaid');

const stM = mkState();
const rM = E.runImmediate(stM, 0, 'Effekt::EinsKostenlosAblegen(Pflanze)', F);
eq('EinsKostenlosAblegen 进入 pending', rM.pending.length, 1);
eq('pending 类型正确', rM.pending[0].kind, 'freePlayOne');

// ---------- 7. 抽牌类按森林符号计数 ----------
const stN = mkState();
stN.players[0].forest.push({
  uid: 20, treeId: 'birch', slots: {
    top: { uid: 21, faceId: 'redDeer', hiddenFaceId: 'x' },
    bottom: null, left: null, right: null,
  },
});
const hN = stN.players[0].hand.length;
E.runImmediate(stN, 0, 'Effekt::KartenZiehenAnzTyp(Typsymbol::Hirsch)', F);
eq('按 Hirsch 数量抽牌（1 张鹿）', stN.players[0].hand.length - hN, 1);

console.log('');
for (const p of pass) console.log('  PASS  ' + p);
for (const f of fail) console.log('  FAIL  ' + f);
console.log('');
console.log(`  ${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);