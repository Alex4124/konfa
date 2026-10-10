import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { baselineOffsetsEm, estimateMeasureEm, TEXT_LINE_HEIGHT, TEXT_PAD_X, TEXT_PAD_Y, textExtentEm, textMetrics, type MeasureEm } from "./annotation-text.ts";
import { formulaBaselinesEm, formulaExtentEm, formulaMetrics, layoutFormula, OVER_EXTRA, OVER_SCALE, OVER_SHIFT, parseFormula, SCRIPT_SCALE, SUB_SHIFT, SUP_SHIFT, wrapFormula, type FormulaToken } from "./chem-formula.ts";

const half: MeasureEm = (s) => Array.from(s).length * 0.5;
const close = (actual: number, expected: number, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);
// Tokens as "type:text" (arrows "arrow:dir[label]", signs "mark:dir"), spaces included.
const show = (token: FormulaToken) => token.type === "arrow" ? `arrow:${token.dir}${token.label ? `[${token.label}]` : ""}` : token.type === "mark" ? `mark:${token.dir}` : `${token.type}:${token.text}`;
const read = (line: string) => parseFormula(line).map(show);
// What the reader sees on the baseline and in the indices, without positions: H2SO4 → "H|2|S|O|4".
const sight = (line: string) => parseFormula(line).map((token) => token.type === "arrow" ? (token.dir === "both" ? "⇄" : "→") : token.type === "mark" ? (token.dir === "up" ? "↑" : "↓") : token.type === "sub" ? `_${token.text}` : token.type === "sup" ? `^${token.text}` : token.type === "over" ? `~${token.text}` : token.text).join("");

describe("parseFormula: indices and coefficients", () => {
  it("turns digits after an element or a bracket into indices", () => {
    assert.deepEqual(read("H2SO4"), ["atom:H", "sub:2", "atom:S", "atom:O", "sub:4"]);
    assert.equal(sight("Ca(OH)2"), "Ca(OH)_2");
    assert.equal(sight("Fe2(SO4)3"), "Fe_2(SO_4)_3");
    assert.equal(sight("K4[Fe(CN)6]"), "K_4[Fe(CN)_6]");
    assert.equal(sight("C6H12O6"), "C_6H_12O_6");
  });

  it("keeps a leading number as a coefficient", () => {
    assert.deepEqual(read("2H2O"), ["text:2", "atom:H", "sub:2", "atom:O"]);
    assert.equal(sight("2H2 + O2 = 2H2O"), "2H_2 + O_2 = 2H_2O");
    assert.equal(sight("22,4 л/моль"), "22,4 л/моль");
    assert.equal(sight("0,5 моль H2"), "0,5 моль H_2");
  });

  it("reads two-letter symbols by case", () => {
    assert.deepEqual(read("NaCl"), ["atom:Na", "atom:Cl"]);
    assert.deepEqual(read("CO"), ["atom:C", "atom:O"]);
    assert.deepEqual(read("Co"), ["atom:Co"]);
  });

  it("treats look-alike Russian letters as element letters", () => {
    assert.deepEqual(read("Н2О"), ["atom:Н", "sub:2", "atom:О"]);
    assert.equal(sight("Са3(РО4)2"), "Са_3(РО_4)_2");
  });

  it("writes letter indices with an underscore", () => {
    assert.equal(sight("C_nH_{2n+2}"), "C_nH_2n+2");
    assert.equal(sight("x_1"), "x_1");
    assert.equal(sight("a_"), "a_");
    assert.equal(sight("a_{}"), "a_{}");
  });

  it("leaves ordinary text alone", () => {
    assert.equal(sight("Запишите уравнение реакции"), "Запишите уравнение реакции");
    assert.equal(sight("бутен-1, 2-метилпропан, р-р"), "бутен-1, 2-метилпропан, р-р");
    assert.equal(sight("v = k[A]"), "v = k[A]");
    assert.equal(sight(""), "");
  });
});

describe("parseFormula: charges and oxidation states", () => {
  it("raises a charge after ^", () => {
    assert.deepEqual(read("SO4^2-"), ["atom:S", "atom:O", "sub:4", "sup:2−"]);
    assert.equal(sight("Fe^3+ + 3OH^-"), "Fe^3+ + 3OH^−");
    assert.equal(sight("Na^+"), "Na^+");
    assert.equal(sight("10^-3"), "10^−3");
    assert.equal(sight("1s^2 2s^2 2p^6"), "1s^2 2s^2 2p^6");
    assert.equal(sight("x^{n+1}"), "x^n+1");
  });

  it("reads a sign that ends a formula as its charge, without ^", () => {
    assert.equal(sight("Ag+ + Cl- -> AgCl v"), "Ag^+ + Cl^− → AgCl↓");
    assert.equal(sight("H+ + OH- = H2O"), "H^+ + OH^− = H_2O");
    assert.equal(sight("NH4+ + OH- -> NH3 ^ + H2O"), "NH_4^+ + OH^− → NH_3↑ + H_2O");
    assert.deepEqual(read("NO3-"), ["atom:N", "atom:O", "sub:3", "sup:−"]);
    assert.equal(sight("H3O+, MnO4-, (OH-)"), "H_3O^+, MnO_4^−, (OH^−)");
    assert.equal(sight("K = [H+][OH-]"), "K = [H^+][OH^−]");
    // Between formulas the sign stays a plus, a minus or a bond.
    assert.equal(sight("H2+O2"), "H_2+O_2");
    assert.equal(sight("2H2 + O2"), "2H_2 + O_2");
    assert.equal(sight("CH3-CH3"), "CH_3–CH_3");
    assert.equal(sight("a + b - c"), "a + b − c");
    assert.equal(sight("бутен-1, 2-метилпропан, р-р"), "бутен-1, 2-метилпропан, р-р");
  });

  it("splits digits before such a sign into an index and a charge", () => {
    // A lone element or a complex: the digit is the charge.
    assert.deepEqual(read("Ba2+"), ["atom:Ba", "sup:2+"]);
    assert.equal(sight("Fe3+ + 3OH- -> Fe(OH)3 v"), "Fe^3+ + 3OH^− → Fe(OH)_3↓");
    assert.equal(sight("2Al3+ + 3S2-"), "2Al^3+ + 3S^2−");
    assert.equal(sight("[Cu(NH3)4]2+"), "[Cu(NH_3)_4]^2+");
    // Several digits: the last one is the charge.
    assert.deepEqual(read("SO42-"), ["atom:S", "atom:O", "sub:4", "sup:2−"]);
    assert.equal(sight("Ba2+ + SO42- -> BaSO4 v"), "Ba^2+ + SO_4^2− → BaSO_4↓");
    assert.equal(sight("Cr2O72-, PO43-, O22-"), "Cr_2O_7^2−, PO_4^3−, O_2^2−");
    // One digit after a group of elements is its index.
    assert.equal(sight("NH4+, MnO4-, Fe(OH)2+"), "NH_4^+, MnO_4^−, Fe(OH)_2^+");
    // With ^ the reading is whatever was typed.
    assert.equal(sight("FeOH^2+, I3^-"), "FeOH^2+, I_3^−");
    assert.equal(sight("C10H22"), "C_10H_22");
  });

  it("writes the electron with its minus", () => {
    assert.deepEqual(read("e-"), ["text:e", "sup:−"]);
    assert.equal(sight("Fe^0 - 2e- -> Fe^2+"), "Fe^0 − 2e^− → Fe^2+");
    assert.equal(sight("be-bop"), "be-bop");
  });

  it("puts an oxidation state over its element", () => {
    assert.deepEqual(read("S^^+6"), ["atom:S", "over:+6"]);
    assert.deepEqual(read("O^^-24"), ["atom:O", "over:−2", "sub:4"]);
    assert.deepEqual(read("Cl2^^0"), ["atom:Cl", "sub:2", "over:0"]);
    assert.equal(sight("H^^+1N^^+5O3^^-2"), "H~+1N~+5O_3~−2");
  });

  it("keeps ^^ as typed when nothing can carry it", () => {
    assert.equal(sight("^^+6"), "^^+6");
    assert.equal(sight("S^^x"), "S^^x");
    assert.equal(sight("S^^"), "S^^");
  });
});

describe("parseFormula: arrows, signs and bonds", () => {
  it("reads typed and ready-made arrows the same", () => {
    assert.deepEqual(read("A -> B"), ["atom:A", "space: ", "arrow:right", "space: ", "atom:B"]);
    assert.deepEqual(read("A → B"), read("A -> B").map((token) => token));
    assert.equal(sight("N2 + 3H2 <-> 2NH3"), "N_2 + 3H_2 ⇄ 2NH_3");
    assert.equal(sight("A <=> B ⇄ C"), "A ⇄ B ⇄ C");
  });

  it("keeps the condition with its arrow", () => {
    assert.deepEqual(read("A ->[t, кат] B"), ["atom:A", "space: ", "arrow:right[t, кат]", "space: ", "atom:B"]);
    assert.deepEqual(read("A →[H2SO4] B")[2], "arrow:right[H2SO4]");
    assert.deepEqual(read("A ->[t B"), ["atom:A", "space: ", "arrow:right", "text:[t", "space: ", "atom:B"]);
  });

  it("draws gas and precipitate after a formula only", () => {
    assert.deepEqual(read("BaSO4 v"), ["atom:Ba", "atom:S", "atom:O", "sub:4", "mark:down"]);
    assert.deepEqual(read("CO2 ^"), ["atom:C", "atom:O", "sub:2", "mark:up"]);
    assert.equal(sight("CaCO3 -> CaO + CO2↑"), "CaCO_3 → CaO + CO_2↑");
    assert.equal(sight("AgCl v + NaNO3"), "AgCl↓ + NaNO_3");
    assert.equal(sight("скорость v равна"), "скорость v равна");
    assert.equal(sight("v"), "v");
  });

  it("writes bonds, the hydrate dot and the minus", () => {
    assert.equal(sight("CH3-CH=CH2"), "CH_3–CH=CH_2");
    assert.equal(sight("CH#CH"), "CH≡CH");
    assert.equal(sight("CH3-(CH2)4-CH3"), "CH_3–(CH_2)_4–CH_3");
    assert.equal(sight("-OH"), "–OH");
    assert.equal(sight("CuSO4*5H2O"), "CuSO_4·5H_2O");
    assert.equal(sight("2 * 3"), "2 * 3");
    assert.equal(sight("# 1"), "# 1");
    assert.equal(sight("5 - 3"), "5 − 3");
    assert.equal(sight("(-1)"), "(−1)");
    assert.equal(sight("10-15 мл"), "10–15 мл");
  });

  it("covers the whole line with tokens in order", () => {
    for (const line of ["2KMnO4 ->[t] K2MnO4 + MnO2 + O2 ^", "  S^^+6 + 2e- -> S^^+4", "C_nH_{2n+2}", "Н2О v", "a  b"]) {
      const tokens = parseFormula(line);
      let at = 0;
      for (const token of tokens) {
        assert.equal(token.start, at, line);
        assert.ok(token.end > token.start, line);
        at = token.end;
      }
      assert.equal(at, line.length, line);
    }
  });
});

describe("layoutFormula", () => {
  it("lowers indices and raises charges at a smaller size", () => {
    const layout = layoutFormula("SO4^2-", half);
    assert.deepEqual(layout.runs.map((run) => [run.text, run.dy, run.scale]), [["SO", 0, 1], ["4", SUB_SHIFT, SCRIPT_SCALE], ["2−", SUP_SHIFT, SCRIPT_SCALE]]);
    close(layout.runs[1].x, 1);
    assert.equal(layout.over, false);
    assert.deepEqual(layout.strokes, []);
  });

  it("stands a charge over the index it follows", () => {
    const ion = layoutFormula("SO4^2-", half);
    close(ion.runs[2].x, ion.runs[1].x);
    close(ion.width, 1 + SCRIPT_SCALE); // as wide as the wider of the two
    const narrow = layoutFormula("PO4^3-", half), wide = layoutFormula("C10H22^+", half);
    close(narrow.width, 1 + SCRIPT_SCALE);
    close(wide.width, 0.5 + SCRIPT_SCALE + 0.5 + SCRIPT_SCALE);
    // Only the pair: a second charge, or an index after text, goes on along the line.
    const chain = layoutFormula("X_2^3^4", half);
    assert.deepEqual(chain.runs.map((run) => run.x), [0, 0.5, 0.5, 0.5 + 0.5 * SCRIPT_SCALE]);
    const apart = layoutFormula("Fe^3+ + SO4^2-", half);
    assert.ok(apart.runs.every((run, index) => index === 0 || run.x >= apart.runs[index - 1].x));
    close(layoutFormula("Fe^3+", half).runs[1].x, 1);
  });

  it("is plain text for a line without chemistry", () => {
    const layout = layoutFormula("просто текст", half);
    assert.deepEqual(layout.runs, [{ text: "просто текст", x: 0, dy: 0, scale: 1 }]);
    close(layout.width, 6);
    assert.deepEqual(layoutFormula("", half), { runs: [], strokes: [], width: 0, over: false, atoms: [] });
  });

  it("centres an oxidation state over its element without widening the line", () => {
    const layout = layoutFormula("HNO3", half), marked = layoutFormula("HN^^+5O3", half);
    close(marked.width, layout.width);
    assert.equal(marked.over, true);
    const over = marked.runs.find((run) => run.dy === OVER_SHIFT);
    assert.ok(over);
    assert.equal(over.scale, OVER_SCALE);
    close(over.x + 0.5 * 2 * OVER_SCALE / 2, 0.75); // over the N, the second letter
    assert.ok(marked.runs.some((run) => run.text === "HNO" && run.x === 0)); // the letters stay one run
  });

  it("never lets neighbouring oxidation states overlap or leave the line", () => {
    const layout = layoutFormula("I^^-1I^^-1", (s) => Array.from(s).length * (s.startsWith("I") ? 0.2 : 0.6));
    const overs = layout.runs.filter((run) => run.dy === OVER_SHIFT);
    assert.equal(overs.length, 2);
    assert.equal(overs[0].x, 0);
    assert.ok(overs[1].x >= overs[0].x + 1.2 * OVER_SCALE);
    assert.ok(layout.width >= overs[1].x + 1.2 * OVER_SCALE - 1e-9);
  });

  it("draws arrows as strokes and stretches them to their condition", () => {
    const bare = layoutFormula("A -> B", half), both = layoutFormula("A <-> B", half), long = layoutFormula("A ->[очень длинное условие] B", half);
    assert.equal(bare.strokes.length, 3);
    assert.equal(both.strokes.length, 4);
    close(bare.width, both.width);
    assert.ok(long.width > bare.width);
    const shaft = bare.strokes[0];
    close(shaft[0][0], 1);
    assert.equal(shaft[0][1], shaft[1][1]);
    assert.ok(shaft[0][1] < 0);
    const label = long.runs.find((run) => run.text.startsWith("очень"));
    assert.ok(label && label.dy < shaft[0][1] && label.scale < 1);
    const arrow = long.strokes[0];
    assert.ok(label.x > arrow[0][0] && label.x + half(label.text) * label.scale < arrow[1][0]);
  });

  it("formats the condition like a formula", () => {
    const layout = layoutFormula("A ->[H2SO4] B", half);
    const two = layout.runs.find((run) => run.text === "2");
    assert.ok(two && two.scale < SCRIPT_SCALE);
  });

  it("draws gas and precipitate signs upright", () => {
    const up = layoutFormula("CO2 ^", half), down = layoutFormula("BaSO4 v", half);
    assert.equal(up.strokes.length, 3);
    assert.equal(up.strokes[0][0][0], up.strokes[0][1][0]);
    assert.ok(up.strokes[0][1][1] < up.strokes[0][0][1]);
    assert.ok(down.strokes[0][1][1] > down.strokes[0][0][1]);
    assert.ok(up.width > layoutFormula("CO2", half).width);
  });

  it("reports where each element stands", () => {
    const layout = layoutFormula("CH3-OH", half);
    assert.equal(layout.atoms.length, 4);
    close(layout.atoms[0].x, 0);
    close(layout.atoms[1].x, 0.5);
    close(layout.atoms[2].x, 1 + 0.5 * SCRIPT_SCALE + 0.5);
    for (const atom of layout.atoms) close(atom.width, 0.5);
  });
});

describe("line heights", () => {
  it("matches plain text when there are no oxidation states", () => {
    const layouts = ["H2O", "NaCl"].map((line) => layoutFormula(line, half));
    assert.deepEqual(formulaBaselinesEm(layouts), baselineOffsetsEm(2));
    close(formulaExtentEm(layouts).height, textExtentEm(["a", "b"], half).height);
    close(formulaExtentEm([]).height, TEXT_LINE_HEIGHT + 2 * TEXT_PAD_Y);
  });

  it("makes a line with oxidation states taller, above its baseline", () => {
    const layouts = ["S^^+6", "H2O"].map((line) => layoutFormula(line, half));
    const [first, second] = formulaBaselinesEm(layouts), plain = baselineOffsetsEm(2);
    close(first, plain[0] + OVER_EXTRA);
    close(second, plain[1] + OVER_EXTRA);
    close(formulaExtentEm(layouts).height, 2 * TEXT_LINE_HEIGHT + OVER_EXTRA + 2 * TEXT_PAD_Y);
    close(formulaExtentEm(layouts).width, 1 + 0.5 * SCRIPT_SCALE + 2 * TEXT_PAD_X);
  });
});

describe("wrapFormula", () => {
  it("breaks at spaces only and never inside a formula", () => {
    assert.deepEqual(wrapFormula("2H2 + O2 = 2H2O", 4, half), ["2H2 + O2", "= 2H2O"]);
    assert.deepEqual(wrapFormula("C6H12O6", 1, half), ["C6H12O6"]);
    assert.deepEqual(wrapFormula("a\n\nb", 10, half), ["a", "", "b"]);
    assert.deepEqual(wrapFormula("  a b", 10, half), ["  a b"]);
  });

  it("keeps the condition with its arrow and the sign with its formula", () => {
    assert.deepEqual(wrapFormula("A ->[t, кат] B", 1, half), ["A", "->[t, кат]", "B"]);
    assert.deepEqual(wrapFormula("NaCl + AgNO3 -> AgCl v", 1, half), ["NaCl", "+", "AgNO3", "->", "AgCl v"]);
  });

  it("does not wrap without a finite width", () => {
    assert.deepEqual(wrapFormula("a b\nc", NaN, half), ["a b", "c"]);
    assert.deepEqual(wrapFormula("a b", Infinity, half), ["a b"]);
  });

  it("gives lines that read exactly as the unwrapped text does", () => {
    const samples = [
      "2KMnO4 ->[t] K2MnO4 + MnO2 + O2 ^", "Fe^0 - 2e- -> Fe^2+", "BaCl2 + Na2SO4 -> BaSO4 v + 2NaCl", "CH3-CH2-OH ->[H2SO4, t] CH2=CH2 + H2O",
      "S^^+6 + 2e- -> S^^+4", "CuSO4*5H2O -> CuSO4 + 5H2O", "C_nH_{2n+2} + O2 -> CO2 + H2O", "Н2О v и бутен-1 - 2 = 5 - 3",
    ];
    const visible = (line: string) => parseFormula(line).filter((token) => token.type !== "space").map(show);
    for (const text of samples) {
      for (const width of [0.5, 2, 4, 7]) {
        const lines = wrapFormula(text, width, estimateMeasureEm);
        assert.deepEqual(lines.flatMap(visible), visible(text), `${text} @ ${width}`);
        for (const line of lines) assert.equal(line, line.trim(), `${text} @ ${width}`);
      }
    }
  });
});

describe("formulaMetrics", () => {
  const box = { width: 1280, height: 720 };

  it("is narrower than the same source as plain text and stays inside its width", () => {
    const input = { text: "2H2 + O2 -> 2H2O", fontSize: 26, maxWidth: 0.6, box, measure: estimateMeasureEm };
    const formula = formulaMetrics(input), plain = textMetrics(input);
    assert.deepEqual(formula.lines, ["2H2 + O2 -> 2H2O"]);
    assert.ok(formula.w > 0 && formula.w < 0.6);
    assert.equal(formula.h, plain.h);
  });

  it("wraps at the given width", () => {
    const metrics = formulaMetrics({ text: "BaCl2 + Na2SO4 -> BaSO4 v + 2NaCl", fontSize: 40, maxWidth: 0.3, box, measure: estimateMeasureEm });
    assert.ok(metrics.lines.length > 1);
    assert.ok(metrics.w <= 0.3 + 1e-9);
    assert.equal(metrics.lines.join(" "), "BaCl2 + Na2SO4 -> BaSO4 v + 2NaCl");
  });

  it("is the same for any frame of one aspect", () => {
    const text = "S^^+6 + 2e- -> S^^+4\nH2SO4(конц.)";
    const small = formulaMetrics({ text, fontSize: 26, maxWidth: 0.5, box: { width: 640, height: 360 }, measure: estimateMeasureEm });
    const large = formulaMetrics({ text, fontSize: 26, maxWidth: 0.5, box: { width: 2560, height: 1440 }, measure: estimateMeasureEm });
    assert.deepEqual(small, large);
  });

  it("grows with an oxidation state and handles an unmeasured frame", () => {
    const plain = formulaMetrics({ text: "SO3", fontSize: 26, maxWidth: 0.6, box, measure: estimateMeasureEm });
    const marked = formulaMetrics({ text: "S^^+6O3", fontSize: 26, maxWidth: 0.6, box, measure: estimateMeasureEm });
    assert.ok(marked.h > plain.h);
    assert.equal(marked.w, plain.w);
    assert.deepEqual(formulaMetrics({ text: "a\nb", box: { width: 0, height: 0 }, measure: estimateMeasureEm }), { lines: ["a", "b"], w: 0, h: 0 });
  });
});
