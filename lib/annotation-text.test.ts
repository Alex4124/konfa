import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fontPx } from "./annotation-geometry.ts";
import { baselineOffsetsEm, contrastRatio, defaultMaxWidth, estimateMeasureEm, fitMaxWidth, graphemes, graphemesFallback, innerWidthEm, nearestTextSize, normalizeText, placeTextAnchor, plateFor, relativeLuminance, TEXT_MAX_CHARS, TEXT_MAX_LINES, textExtentEm, textFits, textLines, textMetrics, wrapText, type MeasureEm } from "./annotation-text.ts";

const half: MeasureEm = (s) => Array.from(s).length * 0.5;
// Proportional widths, so breaks depend on the actual characters.
const proportional: MeasureEm = (s) => {
  let width = 0;
  for (const char of s) width += char === " " ? 0.28 : "il.,!ijt".includes(char) ? 0.3 : "mwшщжМШЩЖ".includes(char) ? 0.9 : 0.6;
  return width;
};
const close = (actual: number, expected: number, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const FAMILY = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const THUMB = cp(0x1f44d, 0x1f3fd);
const FLAG = cp(0x1f1eb, 0x1f1ee);
const SHORT_I = cp(0x438, 0x306); // и + combining breve

describe("normalizeText", () => {
  it("unifies line breaks, expands tabs and trims trailing spaces", () => {
    assert.equal(normalizeText("a  \r\nb\tc\rd "), "a\nb  c\nd");
    assert.equal(normalizeText(`a${cp(0x2028)}b`), "a\nb");
  });

  it("keeps at most two blank lines in a row and drops outer blank lines", () => {
    assert.equal(normalizeText("a\n\n\n\n\nb"), "a\n\n\nb");
    assert.equal(normalizeText("a\n\nb"), "a\n\nb");
    assert.equal(normalizeText("\n \n\t\n  x\n\n \n"), "  x");
    assert.equal(normalizeText(" \n\t \n"), "");
  });

  it("drops control characters and lone surrogates", () => {
    assert.equal(normalizeText(`a${String.fromCharCode(0)}b${String.fromCharCode(7)}c${String.fromCharCode(0x7f)}`), "abc");
    assert.equal(normalizeText(`a${String.fromCharCode(0xd800)}b`), "ab");
  });

  it("caps characters at a grapheme boundary and lines at TEXT_MAX_LINES", () => {
    assert.equal(normalizeText("x".repeat(600)).length, TEXT_MAX_CHARS);
    const cut = normalizeText("a".repeat(TEXT_MAX_CHARS - 1) + FAMILY);
    assert.equal(cut, "a".repeat(TEXT_MAX_CHARS - 1));
    assert.ok(normalizeText("a".repeat(497) + FLAG + "b").isWellFormed());
    const many = normalizeText(Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
    assert.equal(many.split("\n").length, TEXT_MAX_LINES);
    assert.equal(many.split("\n").at(-1), "line 39");
  });
});

describe("wrapText", () => {
  it("wraps greedily at spaces and trims the spaces at the break", () => {
    assert.deepEqual(wrapText("aaa bbb ccc", 3.5, half), ["aaa bbb", "ccc"]);
    assert.deepEqual(wrapText("aa    bb", 1.5, half), ["aa", "bb"]);
    assert.deepEqual(wrapText("aa bb ", 10, half), ["aa bb"]);
  });

  it("keeps hard breaks, empty lines and indentation", () => {
    assert.deepEqual(wrapText("aa\n\nbb", 10, half), ["aa", "", "bb"]);
    assert.deepEqual(wrapText("  aa\nbb", 10, half), ["  aa", "bb"]);
    assert.deepEqual(wrapText("", 10, half), [""]);
  });

  it("does not wrap when the width is NaN or Infinity", () => {
    assert.deepEqual(wrapText("aaa bbb\nc", NaN, half), ["aaa bbb", "c"]);
    assert.deepEqual(wrapText("aaa bbb", Infinity, half), ["aaa bbb"]);
  });

  it("splits a word longer than a line, starting it on a new line", () => {
    assert.deepEqual(wrapText("abcdefghij", 2, half), ["abcd", "efgh", "ij"]);
    assert.deepEqual(wrapText("hi abcdefghij x", 2, half), ["hi", "abcd", "efgh", "ij x"]);
    assert.deepEqual(wrapText("ab cd", 0, half), ["a", "b", "c", "d"]);
  });

  it("breaks after a hyphen between letters", () => {
    assert.deepEqual(wrapText("какой-то текст", 3.5, half), ["какой-", "то", "текст"]);
    assert.deepEqual(wrapText("какой-то", 10, half), ["какой-то"]);
  });

  it("never splits emoji or combining sequences", () => {
    assert.deepEqual(wrapText(FAMILY + THUMB + FLAG, 1, half), [FAMILY, THUMB, FLAG]);
    assert.deepEqual(wrapText(SHORT_I.repeat(3), 0.5, half), [SHORT_I, SHORT_I, SHORT_I]);
    for (const line of wrapText(`${FAMILY}${THUMB} ok ${FLAG.repeat(5)}`, 1.5, half)) assert.ok(line.isWellFormed(), line);
  });

  it("keeps every line within the width unless it is a single grapheme", () => {
    const text = "Обратите внимание на эту часть графика, здесь виден рост после релиза, а затем — плато.";
    for (const max of [2, 5, 9.4, 17]) {
      const lines = wrapText(text, max, proportional);
      for (const line of lines) assert.ok(proportional(line) <= max + 1e-6 || graphemes(line).length === 1, `${max}: ${line}`);
      assert.equal(lines.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
    }
  });
});

describe("graphemes", () => {
  it("fallback segmentation matches Intl.Segmenter on emoji and marks", () => {
    const sample = `a${FAMILY}b${THUMB}${FLAG}${SHORT_I}${cp(0x31, 0xfe0f, 0x20e3)}ж`;
    assert.deepEqual(graphemesFallback(sample), graphemes(sample));
    assert.deepEqual(graphemes(sample).length, 8);
  });
});

describe("text metrics", () => {
  it("measures the plate extent with padding", () => {
    const extent = textExtentEm(["ab", "abcd"], half);
    close(extent.width, 2.6);
    close(extent.height, 2.8);
    close(textExtentEm([""], half).height, 1.55);
  });

  it("normalizes the extent to the frame and rounds to 4 decimals", () => {
    assert.deepEqual(textMetrics({ text: "ab\nabcd", fontSize: 26, box: { width: 1280, height: 720 }, measure: half }), { lines: ["ab", "abcd"], w: 0.0528, h: 0.1011 });
    assert.deepEqual(textMetrics({ text: "ab", box: { width: 1280, height: 720 }, measure: half }), textMetrics({ text: "ab", fontSize: 26, box: { width: 1280, height: 720 }, measure: half }), "legacy size is 26 units");
    assert.deepEqual(textMetrics({ text: "ab", fontSize: 26, box: { width: 0, height: 0 }, measure: half }), { lines: ["ab"], w: 0, h: 0 });
  });

  it("gives identical lines and extent at 1280, 640 and 320 px when maxWidth is relative", () => {
    const text = "Обратите внимание на эту часть графика: здесь виден рост после релиза,\nа затем — плато. Сверхдлинноесловобезпробеловкотороенепомещается";
    for (const fontSize of [18, 26, 40]) {
      const results = [[1280, 720], [640, 360], [320, 180], [1366, 768], [683, 384]].map(([width, height]) => {
        const box = { width, height };
        const px = fontPx(fontSize, height);
        const maxWidth = defaultMaxWidth(box, px);
        return { maxWidth, inner: innerWidthEm(maxWidth, box, px), ...textMetrics({ text, fontSize, maxWidth, box, measure: proportional }) };
      });
      assert.ok(results[0].lines.length > 2, "the sample actually wraps");
      for (const result of results.slice(1, 3)) assert.deepEqual(result, results[0]);
      assert.deepEqual(results[4], results[3]);
    }
  });

  it("computes the inner width in em", () => {
    close(innerWidthEm(0.5, { width: 1280 }, 32), 19.4);
    assert.equal(innerWidthEm(0.01, { width: 100 }, 32), 0);
    assert.ok(Number.isNaN(innerWidthEm(0.5, { width: 1280 }, 0)));
  });

  it("textFits rejects too many lines or an extent beyond the frame", () => {
    assert.equal(textFits({ lines: ["a"], w: 0.2, h: 0.1 }), true);
    assert.equal(textFits({ lines: Array.from({ length: TEXT_MAX_LINES + 1 }, () => "a"), w: 0.2, h: 0.9 }), false);
    assert.equal(textFits({ lines: ["a"], w: 0.2, h: 1.01 }), false);
  });

  it("renders author lines verbatim and legacy text by hard breaks", () => {
    assert.deepEqual(textLines({ text: "a b", lines: ["a", "b"] }), ["a", "b"]);
    assert.deepEqual(textLines({ text: "a\r\nb" }), ["a", "b"]);
    assert.deepEqual(textLines({}), [""]);
  });

  it("puts baselines at padding + half-leading + ascent, one line height apart", () => {
    const offsets = baselineOffsetsEm(3);
    assert.equal(offsets.length, 3);
    close(offsets[0], 0.15 + (1.25 - 1.117) / 2 + 0.905);
    close(offsets[2] - offsets[0], 2.5);
    assert.deepEqual(baselineOffsetsEm(0), []);
  });

  it("estimates widths without canvas", () => {
    close(estimateMeasureEm("ab"), 1.24);
    close(estimateMeasureEm(`a ${FAMILY}`), 1.9);
  });
});

describe("placement", () => {
  it("defaults to about 20 em, within 0.12..0.6 of the frame width", () => {
    assert.equal(defaultMaxWidth({ width: 1280 }, 26), 0.4063);
    assert.equal(defaultMaxWidth({ width: 1280 }, 40), 0.6);
    assert.equal(defaultMaxWidth({ width: 3000 }, 10), 0.12);
    assert.equal(defaultMaxWidth({ width: 0 }, 26), 0.6);
  });

  it("shrinks the width near the right edge, but not below the minimum", () => {
    assert.equal(fitMaxWidth(0.1, 0.4), 0.4);
    assert.equal(fitMaxWidth(0.7, 0.4), 0.3);
    assert.equal(fitMaxWidth(0.95, 0.4), 0.12);
  });

  it("keeps the anchor so that the extent stays inside the frame", () => {
    assert.deepEqual(placeTextAnchor([0.95, 0.5], { w: 0.2, h: 0.1 }), [0.8, 0.5]);
    assert.deepEqual(placeTextAnchor([0.5, 0.97], { w: 0.1, h: 0.1 }), [0.5, 0.9]);
    assert.deepEqual(placeTextAnchor([-0.1, 0.123456], { w: 0.1, h: 0.1 }), [0, 0.1235]);
    assert.deepEqual(placeTextAnchor([0.5, 0.5], { w: 1.4, h: NaN }), [0, 0.5]);
  });

  it("maps units to the nearest S/M/L size", () => {
    assert.equal(nearestTextSize(18), "s");
    assert.equal(nearestTextSize(26), "m");
    assert.equal(nearestTextSize(40), "l");
    assert.equal(nearestTextSize(60), "l");
  });
});

describe("plateFor", () => {
  it("computes WCAG relative luminance", () => {
    assert.equal(relativeLuminance("#ffffff"), 1);
    assert.equal(relativeLuminance("#000"), 0);
    close(relativeLuminance("#808080"), 0.2158605, 1e-6);
    close(relativeLuminance("#FF0000"), 0.2126);
    assert.ok(Number.isNaN(relativeLuminance("red")));
    close(contrastRatio("#000000", "#ffffff"), 21);
  });

  it("puts dark text on a light plate and light text on a dark plate", () => {
    assert.equal(plateFor("#000000").fill, "#ffffff");
    assert.equal(plateFor("#0000ff").fill, "#ffffff");
    for (const color of ["#ffffff", "#6de7d4", "#ffcc75", "#ff7794", "#b9a7ff"]) {
      const plate = plateFor(color);
      assert.equal(plate.fill, "#0e192c", color);
      assert.ok(contrastRatio(color, plate.fill) >= 4.5, color);
    }
    assert.equal(plateFor("nope").fill, "#0e192c");
  });

  it("always picks the plate with the higher contrast", () => {
    for (let i = 0; i < 4096; i += 37) {
      const color = `#${i.toString(16).padStart(3, "0")}`;
      const plate = plateFor(color);
      const other = plate.fill === "#ffffff" ? "#0e192c" : "#ffffff";
      assert.ok(contrastRatio(color, plate.fill) >= contrastRatio(color, other), color);
      assert.ok(plate.fillOpacity > 0.5 && plate.fillOpacity <= 1);
    }
  });
});
