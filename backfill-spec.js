'use strict';
// 回填 spec.json 里被截断的 persistent / Bedingung 串（参数来自 Rust 源）
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'forest-shuffle', 'spec.json');

const PATCH = {
  // Dauereffekt::BeiKarteAusspielenTyp(Typsymbol, Effekt)
  chanterelle:     { persistent: 'Dauereffekt::BeiKarteAusspielenTyp(Baum, Effekt::KartenZiehen(1))' },
  flyAgaric:       { persistent: 'Dauereffekt::BeiKarteAusspielenTyp(Pfotentier, Effekt::KartenZiehen(1))' },
  blackTrumpet:    { persistent: 'Dauereffekt::BeiKarteAusspielenTyp(Alpen, Effekt::KartenZiehen(1))' },
  blackthorn:      { persistent: 'Dauereffekt::BeiKarteAusspielenTyp(Schmetterling, Effekt::KartenZiehen(1))' },
  commonHazel:     { persistent: 'Dauereffekt::BeiKarteAusspielenTyp(Fledermaus, Effekt::KartenZiehen(1))' },
  elderberry:      { persistent: 'Dauereffekt::BeiKarteAusspielenTyp(Pflanze, Effekt::KartenZiehen(1))' },
  // Dauereffekt::BeiKarteAusspielenPositionTyp(Kartenposition, Typsymbol, Effekt)
  parasolMushroom: { persistent: 'Dauereffekt::BeiKarteAusspielenPositionTyp(Unten, Baum, Effekt::KartenZiehen(1))' },
  pennyBun:        { persistent: 'Dauereffekt::BeiKarteAusspielenPositionTyp(Unten, Baum, Effekt::KartenZiehen(1))' },
  // Effekt::Bedingung(&Effekt, Bedingung) —— Rust: Bedingung(&Effekt::Extrazug, MinAnzTyp(1, Fledermaus))
  barnOwl:         { immediate: 'Effekt::Bedingung(MinAnzTyp(1, Fledermaus), Effekt::Extrazug)' },
};

const spec = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const hit = [];
for (const g of ['base', 'alpine', 'woodland']) {
  for (const c of (spec.cards[g] || [])) {
    const patch = PATCH[c.ident];
    if (!patch) continue;
    for (const [k, v] of Object.entries(patch)) { c[k] = v; }
    hit.push(g + ':' + c.ident);
  }
}
fs.writeFileSync(FILE, JSON.stringify(spec, null, 2) + '\n', 'utf8');
console.log('patched ' + hit.length + ': ' + hit.join(', '));