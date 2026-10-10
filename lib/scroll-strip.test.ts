import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { boardExtent, edgeExit, EMPTY_LAYOUT, followWidth, NO_TILES, posAt, readingTile, stepTile, stripLayout, stripWidth, tileAt, topAt, uniformLayout, visibleTiles } from "./scroll-strip.ts";

const near = (actual: number, expected: number, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≉ ${expected}`);
const BAND = 9 / 16;

describe("stripLayout", () => {
  it("stacks tiles by their aspect with gaps between them", () => {
    const layout = stripLayout([2, 1, 0.5], 0.1);
    assert.deepEqual(layout.heights, [0.5, 1, 2]);
    near(layout.tops[1], 0.6);
    near(layout.tops[2], 1.7);
    near(layout.total, 3.7);
    assert.deepEqual(stripLayout([]), { tops: [], heights: [], total: 0 });
    assert.equal(stripLayout([0, Number.NaN]).heights.every((height) => height === 1), true);
  });

  it("the board is equal bands without gaps", () => {
    const board = uniformLayout(200, 16 / 9);
    assert.equal(board.tops.length, 200);
    near(board.tops[199], 199 * BAND, 1e-9);
    near(board.total, 200 * BAND, 1e-9);
  });
});

describe("positions", () => {
  const layout = stripLayout([2, 1, 0.5], 0.1); // tops 0, 0.6, 1.7; heights 0.5, 1, 2

  it("round-trip between a position and a row", () => {
    for (const position of [0, 0.5, 1, 1.25, 2, 2.9]) near(posAt(layout, topAt(layout, position)), position, 1e-4);
    near(topAt(layout, 1.25), 0.85);
    near(topAt(layout, 2.5), 2.7);
  });

  it("clamps positions and rows to the strip", () => {
    assert.equal(topAt(layout, -3), 0);
    near(topAt(layout, 99), 3.7);
    assert.equal(topAt(layout, Number.NaN), 0);
    assert.equal(posAt(layout, -1), 0);
    assert.equal(posAt(layout, 50), 3);
    assert.equal(topAt(EMPTY_LAYOUT, 2), 0);
    assert.equal(posAt(EMPTY_LAYOUT, 2), 0);
  });

  it("a row inside a gap is the top of the next tile", () => {
    assert.equal(posAt(layout, 0.55), 1);
    assert.equal(tileAt(layout, 0.55), 0);
    assert.equal(tileAt(layout, 0.6), 1);
    assert.equal(tileAt(layout, 100), 2);
    assert.equal(tileAt(EMPTY_LAYOUT, 0), -1);
  });
});

describe("visibleTiles", () => {
  const board = uniformLayout(200, 16 / 9);

  it("lists the tiles the viewport touches, with overscan", () => {
    assert.deepEqual(visibleTiles(board, 0, 0.6), { first: 0, last: 1 });
    assert.deepEqual(visibleTiles(board, 0, 0.6, BAND), { first: 0, last: 2 });
    assert.deepEqual(visibleTiles(board, 10 * BAND + 0.01, 10 * BAND + 0.3), { first: 10, last: 10 });
    assert.deepEqual(visibleTiles(board, 10 * BAND + 0.01, 10 * BAND + 0.3, BAND), { first: 9, last: 11 });
    assert.deepEqual(visibleTiles(board, 199.5 * BAND, 300), { first: 199, last: 199 });
  });

  it("skips a tile that ended above the viewport in a gap, and handles empty input", () => {
    const pages = stripLayout([2, 2, 2], 0.2); // tops 0, 0.7, 1.4
    assert.deepEqual(visibleTiles(pages, 0.6, 0.9), { first: 1, last: 1 });
    assert.deepEqual(visibleTiles(pages, 0.4, 0.65), { first: 0, last: 0 });
    assert.equal(visibleTiles(EMPTY_LAYOUT, 0, 1), NO_TILES);
    assert.equal(visibleTiles(pages, 5, 6), NO_TILES);
    assert.equal(visibleTiles(pages, 1, 0), NO_TILES);
  });
});

describe("board extent", () => {
  const extent = (bands: number, bottom: number) => boardExtent({ bands, bottom, bandHeight: BAND, max: 200 }) / BAND;

  it("always one blank band below the used bands and below the screen", () => {
    near(extent(1, 0.5), 2);
    near(extent(3, 0.5), 4);
    near(extent(1, 2.5 * BAND), 4, 1e-9);
    near(extent(1, 3 * BAND), 4, 1e-9);
    near(extent(1, 3 * BAND + 0.001), 5, 1e-9);
  });

  it("stops at the limit and survives odd input", () => {
    near(extent(500, 0), 200);
    near(extent(1, 1e9), 200);
    near(extent(0, -5), 2);
    near(extent(Number.NaN, 0), 2);
  });
});

describe("strip width", () => {
  const wide = { width: 1400, height: 500 }, tall = { width: 500, height: 800 };

  it("slides fit whole, portrait pages and the board fill the width", () => {
    near(stripWidth(wide, 16 / 9, true), 500 * 16 / 9);
    assert.equal(stripWidth(tall, 16 / 9, true), 500);
    assert.equal(stripWidth(wide, 0.7, true), 1400);
    assert.equal(stripWidth(wide, 16 / 9, false), 1400);
    assert.equal(stripWidth({ width: 0, height: 0 }, 1, true), 0);
  });

  it("a follower narrows its strip until the teacher's rows fit", () => {
    assert.equal(followWidth({ width: 700, height: 300 }, 0.9, 700), 300 / 0.9);
    assert.equal(followWidth({ width: 400, height: 900 }, 0.6, 400), 400);
    assert.equal(followWidth({ width: 400, height: 900 }, 0, 400), 400);
  });
});

describe("edgeExit", () => {
  const rect = { top: 100, bottom: 300 };

  it("finds the crossing point on the bottom or top edge", () => {
    assert.deepEqual(edgeExit({ x: 10, y: 290 }, { x: 30, y: 310 }, rect), { edge: "bottom", x: 20, y: 300 });
    assert.deepEqual(edgeExit({ x: 50, y: 110 }, { x: 50, y: 60 }, rect), { edge: "top", x: 50, y: 100 });
    assert.deepEqual(edgeExit({ x: 0, y: 300 }, { x: 8, y: 304 }, rect), { edge: "bottom", x: 0, y: 300 });
  });

  it("is null while inside, when moving along the edge, or once already outside", () => {
    assert.equal(edgeExit({ x: 10, y: 150 }, { x: 30, y: 299 }, rect), null);
    assert.equal(edgeExit({ x: 10, y: 300 }, { x: 30, y: 300 }, rect), null);
    assert.equal(edgeExit({ x: 10, y: 320 }, { x: 30, y: 340 }, rect), null);
  });

  it("a jump across the whole band exits through the far edge", () => {
    assert.deepEqual(edgeExit({ x: 0, y: 120 }, { x: 100, y: 520 }, rect), { edge: "bottom", x: 45, y: 300 });
  });
});

describe("the page indicator and its arrows", () => {
  const tall = stripLayout(Array.from({ length: 10 }, () => 0.7), 0.012); // portrait pages, each taller than the screen
  const slides = stripLayout(Array.from({ length: 12 }, () => 16 / 9), 0.012); // three and a bit to a tall screen
  const screen = 1.2, tallScreen = 1.9;
  const shown = (layout: typeof tall, position: number, rows: number) => {
    const top = Math.min(topAt(layout, position), Math.max(0, layout.total - rows));
    return { at: posAt(layout, top), reading: readingTile(layout, top, top + rows) };
  };

  it("names the page at the reading line", () => {
    assert.equal(readingTile(tall, 0, screen), 0);
    assert.equal(readingTile(tall, topAt(tall, 3.5), topAt(tall, 3.5) + screen), 3);
    assert.equal(readingTile(tall, topAt(tall, 3.8), topAt(tall, 3.8) + screen), 4, "page 5 has come a third up the screen");
    assert.equal(readingTile(EMPTY_LAYOUT, 0, 1), -1);
  });

  it("a jump to a page names that page, also when pages are much shorter than the screen", () => {
    for (let page = 0; page < 8; page++) assert.equal(shown(slides, page, tallScreen).reading, page);
    assert.equal(readingTile(slides, topAt(slides, 4.6), topAt(slides, 4.6) + tallScreen), 5, "more than half of the slide has scrolled away");
  });

  it("scrolled to the very end it is the last page; a strip that fits whole stays on the first", () => {
    assert.equal(shown(slides, 11, tallScreen).reading, 11);
    assert.equal(shown(tall, 9, screen).reading, 9);
    assert.equal(readingTile(stripLayout([16 / 9, 16 / 9], 0.012), 0, 2), 0);
  });

  it("«›» always shows the next page from its top, «‹» the one before; neither stays in place", () => {
    for (const [layout, rows] of [[tall, screen], [slides, tallScreen]] as const) {
      const count = layout.tops.length;
      let place = shown(layout, 0, rows);
      const seen = [place.reading];
      for (let guard = 0; guard < 40 && place.reading < count - 1; guard++) {
        const target = stepTile(place.at, place.reading, 1, count);
        const next = shown(layout, target, rows);
        assert.ok(next.at > place.at, `forward from ${place.at} went to ${next.at}`);
        assert.ok(next.reading > place.reading);
        place = next;
        seen.push(place.reading);
      }
      assert.equal(place.reading, count - 1);
      for (let guard = 0; guard < 40 && place.at > 0; guard++) {
        const target = stepTile(place.at, place.reading, -1, count);
        const next = shown(layout, target, rows);
        assert.ok(next.at < place.at, `back from ${place.at} went to ${next.at}`);
        assert.ok(next.reading < place.reading);
        place = next;
      }
      assert.deepEqual([place.at, place.reading], [0, 0]);
      if (layout === tall) assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "page by page");
    }
  });

  it("from the middle of a page «‹» goes to the page before the one the indicator names, or to its top", () => {
    assert.equal(stepTile(5.3, 5, -1, 10), 4);
    assert.equal(stepTile(5.8, 6, -1, 10), 5);
    assert.equal(stepTile(5.8, 6, 1, 10), 7);
    assert.equal(stepTile(5.3, 5, 1, 10), 6);
    assert.equal(stepTile(0, 0, -1, 10), 0);
    assert.equal(stepTile(9, 9, 1, 10), 9);
  });
});
