import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Initialize fflate for onomastic registry decompression
const fflateCode = readFileSync(new URL("../../lib/fflate.js", import.meta.url), "utf8");
const fflateModule = { exports: {} };
new Function("module", "exports", fflateCode)(fflateModule, fflateModule.exports);
globalThis.fflate = fflateModule.exports;

import { KEYS } from "./rules.js";
import { initOnomasticRegistry } from "./onomastic.js";
import {
  declinedPersonTokenBase,
  nameKey,
  generateCzechNameForms,
  isCommonCzechNonPersonWord
} from "./morphology.js";
import { detect, apply, bindReplacer, effectiveHits } from "./detector.js";
import { replaceAcrossRuns } from "../formats/xlsx.js";

initOnomasticRegistry();

const ALL_ENABLED = Object.fromEntries(KEYS.map(k => [k, true]));

function runDetect(text, options = {}) {
  return detect(text, ALL_ENABLED, [], {
    profile: "publicai",
    suspicion: "medium",
    ...options
  });
}

test("rejects common Czech non-person capitalized phrases at medium and high suspicion", () => {
  const text = [
    "Dokument obsahuje pojmy Smluvní Strany, Občanský Zákoník, Evropská Unie,",
    "Veřejná Zakázka, Technická Zpráva, Finanční Správa, Základní Škola a Stavební Úřad."
  ].join(" ");

  for (const suspicion of ["medium", "high"]) {
    const hits = runDetect(text, { suspicion });
    const nameHits = hits.filter(h => h.type === "name");
    assert.deepEqual(
      nameHits.map(h => h.value),
      [],
      `Expected no false person hits at suspicion=${suspicion}, got: ${nameHits.map(h => h.value).join(", ")}`
    );
  }
  assert.equal(isCommonCzechNonPersonWord("Zákoník"), true);
  assert.equal(isCommonCzechNonPersonWord("Smluvní"), true);
});

test("rejects standalone declined common nouns while detecting genuine declined surnames", () => {
  const falseText =
    "Smlouva byla uzavřena mezi Účastníkem a Zástupcem, přičemž Dodatkem a Výsledkem se řídí Zákoníkem. Vlastníkovi i Ředitelové byli informováni.";
  const falseNames = runDetect(falseText, { suspicion: "high" }).filter(h => h.type === "name");
  assert.deepEqual(
    falseNames.map(h => h.value),
    [],
    `Unexpected false declined nouns: ${falseNames.map(h => h.value).join(", ")}`
  );

  const trueText = "Jednali jsme s Novákem, předali podklady Novákovi a konzultovali s Kovářem.";
  const trueNames = runDetect(trueText, { suspicion: "medium" }).filter(h => h.type === "name");
  const values = trueNames.map(h => h.value);
  assert.ok(values.includes("Novákem"), `Expected Novákem to be detected, got: ${values.join(", ")}`);
  assert.ok(values.includes("Novákovi"), `Expected Novákovi to be detected, got: ${values.join(", ")}`);
  assert.ok(values.includes("Kovářem"), `Expected Kovářem to be detected, got: ${values.join(", ")}`);
});

test("separates Jan Novák, Petr Novák, and Eva Nováková into distinct entities without cross-contamination", () => {
  const text = [
    "Účastníci jednání: Jan Novák, Petr Novák a Eva Nováková.",
    "Později hovořila paní Nováková s Janem Novákem, zatímco Petr Novák vyhotovil zápis.",
    "Podklady byly předány Janu Novákovi."
  ].join("\n");

  const hits = runDetect(text);
  const eff = effectiveHits(hits).filter(h => h.type === "name");
  const rep = bindReplacer("pseudo", "cs", hits);

  const jan = eff.find(h => h.value === "Jan Novák");
  const janem = eff.find(h => h.value === "Janem Novákem");
  const janu = eff.find(h => h.value === "Janu Novákovi");
  const petrAll = eff.filter(h => h.value === "Petr Novák");
  const petr1 = petrAll[0];
  const eva = eff.find(h => h.value === "Eva Nováková");
  const pani = eff.find(h => /Nováková/.test(h.value) && h !== eva);

  assert.ok(jan, "Jan Novák detected");
  assert.ok(janem, "Janem Novákem detected");
  assert.ok(janu, "Janu Novákovi detected");
  assert.ok(petr1, "Petr Novák detected");
  assert.equal(petrAll.length, 2, "Both occurrences of Petr Novák detected");
  assert.ok(eva, "Eva Nováková detected");
  assert.ok(pani, "paní Nováková detected");

  // Jan Novák declensions share one entityKey
  assert.equal(janem.entityKey, jan.entityKey);
  assert.equal(janu.entityKey, jan.entityKey);

  // Petr Novák must NEVER be merged into Jan Novák
  for (const p of petrAll) {
    assert.notEqual(p.entityKey, jan.entityKey, "Petr Novák must not share Jan Novák's entityKey");
    assert.notEqual(p.entityKey, eva.entityKey, "Petr Novák must not share Eva Nováková's entityKey");
  }

  // Eva Nováková and paní Nováková must NEVER be merged into Jan Novák or Petr Novák
  assert.notEqual(eva.entityKey, jan.entityKey, "Eva Nováková must not share Jan Novák's entityKey");
  assert.equal(pani.entityKey, eva.entityKey, "paní Nováková should align with Eva Nováková");

  // Distinct pseudonym suffixes
  const janTok = rep(jan);
  const petrTok = rep(petr1);
  const evaTok = rep(eva);
  assert.notEqual(janTok, petrTok);
  assert.notEqual(janTok, evaTok);
  assert.notEqual(petrTok, evaTok);
  assert.match(rep(janem), /^\[OSOBOU_\d+\]$/);
  assert.match(rep(janu), /^\[OSOBĚ_\d+\]$/);
});

test("handles Czech person declension, titles, fleeting -e- surnames, and dual Jan/Jana keys", () => {
  assert.equal(declinedPersonTokenBase("OSOBA", { type: "name", value: "Ing. Evu Novákovou" }, "cs"), "OSOBA");
  assert.equal(declinedPersonTokenBase("OSOBA", { type: "name", value: "Janě Novákové" }, "cs"), "OSOBĚ");
  assert.equal(declinedPersonTokenBase("OSOBA", { type: "name", value: "Evě Svobodové" }, "cs"), "OSOBĚ");
  assert.equal(declinedPersonTokenBase("OSOBA", { type: "name", value: "panem Novákem" }, "cs"), "OSOBOU");
  assert.equal(declinedPersonTokenBase("OSOBA", { type: "name", value: "panu Novákovi" }, "cs"), "OSOBĚ");

  assert.equal(nameKey("Jana Nováka"), "jan novák");
  assert.equal(nameKey("Jana Nováková"), "jana nováková");
  assert.equal(nameKey("Ing. Jan Novák, Ph.D."), "jan novák");

  const havelForms = generateCzechNameForms("Václav Havel");
  assert.ok(havelForms.includes("Havla"), "Expected fleeting -e- genitive Havla");
  assert.ok(havelForms.includes("Havlovi"), "Expected fleeting -e- dative Havlovi");
  assert.ok(havelForms.includes("Havlem"), "Expected fleeting -e- instrumental Havlem");
  assert.ok(!generateCzechNameForms("Jan Novák").includes("Nováke"), "Should not generate bogus Nováke");
});

test("avoids false address hits on document citations and execution headers, and trims greedy address spans", () => {
  const nonAddrText = [
    "Viz Příloha 1/2 a Zákon 89/2012 Sb., Článek 3/4, Dodatek 2/2026, Strana 1/4.",
    "V Praze dne 11. 9. 2026"
  ].join("\n");

  const nonAddrHits = runDetect(nonAddrText, { suspicion: "high" }).filter(h => h.type === "address");
  assert.deepEqual(
    nonAddrHits.map(h => h.value),
    [],
    `Unexpected false address hits: ${nonAddrHits.map(h => h.value).join(", ")}`
  );

  const greedyText = "Jan Novák, bytem Komenského 12/4, 602 00 Brno, nar. 12. 3. 1978, tel. +420 777 123 456.";
  const hits = effectiveHits(runDetect(greedyText));
  const addr = hits.find(h => h.type === "address");
  const dob = hits.find(h => h.type === "dob");
  const phone = hits.find(h => h.type === "phone");

  assert.ok(addr, "Expected address hit");
  assert.ok(dob, "Expected DOB hit");
  assert.ok(phone, "Expected phone hit");
  assert.ok(!addr.value.includes("1978"), `Address must not swallow DOB: "${addr.value}"`);
  assert.ok(!addr.value.includes("777"), `Address must not swallow phone: "${addr.value}"`);
});

test("rejects currency amounts, invalid 00420 lengths, and digit substrings in phone detection", () => {
  const text = [
    "Celková cena činí 250 000 000 Kč (cca 150 000 000 EUR).",
    "Neplatný tvar 00420 123 4567 a dlouhé číslo 123456789012 nejsou telefon.",
    "Kontakt: +420 777 123 456 nebo 00420 602 987 654."
  ].join("\n");

  const phones = effectiveHits(runDetect(text, { suspicion: "high" }))
    .filter(h => h.type === "phone")
    .map(h => h.value);

  assert.ok(phones.includes("+420 777 123 456"), `Valid +420 phone should be detected, got: ${phones.join(", ")}`);
  assert.ok(phones.includes("00420 602 987 654"), `Valid 14-digit 00420 phone should be detected, got: ${phones.join(", ")}`);
  assert.equal(phones.length, 2, `Expected exactly 2 valid phones, got: ${phones.join(", ")}`);
});

test("rejects generic Czech phrases after system/aplikace/integrace/platforma while keeping real identifiers", () => {
  const text = [
    "Popisujeme systém řízení kvality, aplikace zákona č. 89/2012, integrace dat a platforma pro sdílení.",
    "V produkci běží systém AIS SBS, integrace eSpis, modul SAMO2 a systém Pošta."
  ].join("\n");

  const systems = effectiveHits(runDetect(text, { suspicion: "high" }))
    .filter(h => h.type === "system")
    .map(h => h.value);

  assert.ok(!systems.some(v => /řízení|zákona|integrace dat|platforma pro/i.test(v)), `False system hits: ${systems.join(", ")}`);
  assert.ok(systems.some(v => /AIS SBS/.test(v)), `Expected AIS SBS, got: ${systems.join(", ")}`);
  assert.ok(systems.some(v => /eSpis/.test(v)), `Expected eSpis, got: ${systems.join(", ")}`);
  assert.ok(systems.some(v => /SAMO2/.test(v)), `Expected SAMO2, got: ${systems.join(", ")}`);
  assert.ok(systems.some(v => /Pošta/.test(v)), `Expected Pošta, got: ${systems.join(", ")}`);
});

test("does not misclassify public URLs as internal host hits while detecting internal URLs", () => {
  const text = "Veřejný odkaz https://www.zakonyprolidi.cz/cs/2012-89 a interní https://ais.internal/ticket/1.";
  const hits = effectiveHits(runDetect(text, { suspicion: "high" }));
  const hosts = hits.filter(h => h.type === "host").map(h => h.value);

  assert.ok(!hosts.some(v => v.includes("zakonyprolidi.cz")), `Public URL should not be host hit: ${hosts.join(", ")}`);
  assert.ok(hosts.some(v => v.includes("ais.internal")), `Internal URL should be detected as host, got: ${hosts.join(", ")}`);
});

test("XLSX replaceAcrossRuns enforces token boundaries and avoids substring corruption", () => {
  const runs = [
    { text: "Jana a Janáček předali Jan ", setText(t) { this.text = t; } },
    { text: "kód 456789 a 456.", setText(t) { this.text = t; } }
  ];
  const map = new Map([
    ["Jan", "[OSOBA_001]"],
    ["456", "[ID_001]"]
  ]);
  const changed = replaceAcrossRuns(runs, ["Jan", "456"], map);
  assert.equal(changed, true);
  const combined = runs.map(r => r.text).join("");
  assert.equal(combined, "Jana a Janáček předali [OSOBA_001] kód 456789 a [ID_001].");
});
