import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Size } from "./annotation-geometry.ts";
import { CAMERA_SIZES, DEFAULT_CAMERA_SIZE, MIN_TILE_WIDTH, STRIP_PAD, TILE_ASPECT, TILE_GAP, fitStrip, fitTiles, orderMembers, parseCameraSize, stripLimit, type TileFit } from "./tile-grid.ts";

// A 1366×768 laptop: the stage is 632 px tall, 1006 px wide beside the chat panel and 1366 px without it.
const WINDOW: Size = { width: 1366, height: 768 };
const STAGE: Size = { width: 1006, height: 632 };
const WIDE: Size = { width: 1366, height: 632 };
// The grid stage beside the chat, inside its padding.
const GRID: Size = { width: 966, height: 592 };

const tile = (fit: TileFit) => `${fit.columns}x${fit.rows} ${fit.width}x${Math.round(fit.height)}`;
// Everything fits the box: no tile sticks out and none is cut.
function fits(count: number, box: Size, fit: TileFit) {
  assert.ok(fit.columns * fit.rows >= count, "a slot for everyone");
  assert.ok(fit.columns * fit.width + TILE_GAP * (fit.columns - 1) <= box.width + 1e-9, "fits the width");
  assert.ok(fit.rows * fit.height + TILE_GAP * (fit.rows - 1) <= box.height + 1e-9, "fits the height");
  assert.ok(Math.abs(fit.width / fit.height - TILE_ASPECT) < 1e-9, "16:9");
}

describe("fitTiles", () => {
  it("fills the grid stage with the largest 16:9 tiles", () => {
    assert.equal(tile(fitTiles(3, GRID)), "2x2 479x269");
    assert.equal(tile(fitTiles(6, GRID)), "2x3 341x192");
    assert.equal(tile(fitTiles(10, GRID)), "3x4 252x142");
  });

  it("one person gets the whole box, limited by its narrower side", () => {
    assert.equal(tile(fitTiles(1, GRID)), "1x1 966x543");
    assert.equal(tile(fitTiles(1, { width: 360, height: 600 })), "1x1 360x203");
    assert.equal(tile(fitTiles(1, { width: 1600, height: 450 })), "1x1 800x450");
  });

  it("never lets a tile out of the box", () => {
    for (const box of [GRID, { width: 1326, height: 592 }, { width: 344, height: 560 }, { width: 990, height: 76 }, { width: 160, height: 616 }]) {
      for (let count = 1; count <= 12; count += 1) {
        const fit = fitTiles(count, box, { minWidth: 1 });
        assert.equal(fit.scroll, null);
        fits(count, box, fit);
      }
    }
  });

  it("ties go to fewer rows, and the rows come out even", () => {
    assert.equal(fitTiles(2, { width: 328, height: 188 }, { minWidth: 1 }).rows, 1);
    // Six in a low wide box: 5 + 1 and 3 + 3 give the same tile; the even one wins.
    assert.equal(tile(fitTiles(6, { width: 990, height: 202 })), "3x2 172x97");
    assert.equal(tile(fitTiles(7, { width: 990, height: 202 })), "4x2 172x97");
  });

  it("nobody or no room: nothing", () => {
    for (const fit of [fitTiles(0, GRID), fitTiles(3, { width: 0, height: 0 }), fitTiles(3, { width: 500, height: -1 }), fitTiles(Number.NaN, GRID)]) {
      assert.deepEqual(fit, { columns: 0, rows: 0, width: 0, height: 0, scroll: null });
    }
  });

  it("below the smallest tile the box scrolls down: full rows of small tiles", () => {
    const box = { width: 990, height: 200 };
    const fit = fitTiles(50, box);
    assert.equal(fit.scroll, "y");
    assert.equal(fit.columns, 11);
    assert.equal(fit.rows, 5);
    assert.ok(fit.width >= MIN_TILE_WIDTH);
    assert.ok(fit.columns * fit.width + TILE_GAP * (fit.columns - 1) <= box.width);
    assert.ok(fit.rows * fit.height > box.height, "more than the box holds");
  });

  it("a strip on top scrolls sideways instead, in as many rows as its height holds", () => {
    const one = fitTiles(30, { width: 990, height: 76 }, { overflow: "x" });
    assert.deepEqual({ scroll: one.scroll, rows: one.rows, columns: one.columns, width: one.width }, { scroll: "x", rows: 1, columns: 30, width: 135 });
    // Thirty still fit a taller strip in three rows; sixty do not.
    assert.equal(tile(fitTiles(30, { width: 990, height: 161 }, { overflow: "x" })), "10x3 85x48");
    const three = fitTiles(60, { width: 990, height: 161 }, { overflow: "x" });
    assert.deepEqual({ scroll: three.scroll, rows: three.rows, columns: three.columns, width: three.width }, { scroll: "x", rows: 3, columns: 20, width: 85 });
    assert.ok(three.rows * three.height + TILE_GAP * (three.rows - 1) <= 161);
  });

  it("a box narrower than the smallest tile still gets one column", () => {
    const fit = fitTiles(4, { width: 60, height: 100 });
    assert.deepEqual({ columns: fit.columns, rows: fit.rows, width: fit.width, scroll: fit.scroll }, { columns: 1, rows: 4, width: 60, scroll: "y" });
  });
});

describe("stripLimit", () => {
  it("grows with the camera size", () => {
    assert.deepEqual(CAMERA_SIZES.map((size) => stripLimit(size, "top", STAGE, WINDOW)), [84, 168, 210]);
    assert.deepEqual(CAMERA_SIZES.map((size) => stripLimit(size, "left", WIDE, WINDOW)), [176, 300, 409]);
  });

  it("the small size is the old fixed strip", () => {
    // clamp(64px, 11vh, 136px) and clamp(100px, 15vw, 176px)
    assert.equal(stripLimit("s", "top", { width: 360, height: 620 }, { width: 360, height: 400 }), 64);
    assert.equal(stripLimit("s", "top", { width: 1900, height: 1300 }, { width: 1920, height: 1440 }), 136);
    assert.equal(stripLimit("s", "left", { width: 640, height: 300 }, { width: 640, height: 360 }), 100);
  });

  it("never takes more than a third of the area", () => {
    assert.equal(stripLimit("l", "top", { width: 900, height: 300 }, { width: 900, height: 460 }), 100);
    assert.equal(stripLimit("l", "left", { width: 480, height: 300 }, { width: 900, height: 460 }), 160);
    assert.equal(stripLimit("m", "top", { width: 0, height: 0 }, WINDOW), 0);
  });
});

describe("fitStrip", () => {
  const strip = (count: number, size: "s" | "m" | "l", area = STAGE) => fitStrip(count, "top", size, area, WINDOW);

  it("shows everyone at each size, beside the chat", () => {
    assert.deepEqual(CAMERA_SIZES.map((size) => tile(strip(4, size).fit)), ["4x1 135x76", "4x1 241x136", "4x1 241x136"]);
    assert.deepEqual(CAMERA_SIZES.map((size) => tile(strip(6, size).fit)), ["6x1 135x76", "6x1 158x89", "3x2 172x97"]);
    assert.deepEqual(CAMERA_SIZES.map((size) => tile(strip(10, size).fit)), ["10x1 91x51", "5x2 135x76", "5x2 172x97"]);
    for (const size of CAMERA_SIZES) for (const count of [1, 4, 6, 10]) assert.equal(strip(count, size).fit.scroll, null);
  });

  it("is only as thick as its tiles need", () => {
    assert.equal(strip(4, "s").extent, 84);
    assert.equal(strip(4, "m").extent, 144); // 241×135.6 tiles and the padding, not the 168 px it may take
    assert.equal(strip(4, "l").extent, 144);
    assert.equal(strip(10, "s").extent, 60);
    assert.equal(strip(10, "l").extent, 210);
  });

  it("an empty room has no strip", () => {
    assert.equal(strip(0, "m").extent, 0);
    assert.equal(fitStrip(4, "top", "m", { width: 0, height: 0 }, WINDOW).extent, 0);
  });

  it("on the left the tiles stack in columns and the strip is as wide as they need", () => {
    const four = fitStrip(4, "left", "m", WIDE, WINDOW);
    assert.equal(tile(four.fit), "1x4 263x148");
    assert.equal(four.extent, 263 + 2 * STRIP_PAD.across);
    const ten = fitStrip(10, "left", "m", WIDE, WINDOW);
    assert.equal(tile(ten.fit), "2x5 142x80");
    assert.equal(ten.extent, 300);
    assert.equal(fitStrip(4, "left", "s", WIDE, WINDOW).extent, 176);
  });

  it("too many for the strip: it scrolls along itself", () => {
    assert.equal(fitStrip(40, "top", "s", STAGE, WINDOW).fit.scroll, "x");
    assert.equal(fitStrip(40, "left", "s", WIDE, WINDOW).fit.scroll, "y");
    assert.equal(fitStrip(40, "top", "s", STAGE, WINDOW).extent, 84);
  });
});

describe("orderMembers", () => {
  const people = [
    { id: "a", role: "speaker" }, { id: "h", role: "host" }, { id: "b", role: "speaker" }, { id: "v", role: "viewer" }, { id: "c", role: "speaker" },
  ];
  const ids = (selfId: string, list = people) => orderMembers(list, selfId).map((person) => person.id).join("");

  it("puts the teacher first and the viewer's own tile last, the rest as they joined", () => {
    assert.equal(ids("b"), "havcb");
    assert.equal(ids("a"), "hbvca");
    assert.equal(ids("c"), "habvc");
  });

  it("the teacher's own tile stays first", () => {
    assert.equal(ids("h"), "habvc");
  });

  it("two teacher devices: the other one first, then this one", () => {
    const two = [{ id: "a", role: "speaker" }, { id: "h1", role: "host" }, { id: "h2", role: "host" }];
    assert.deepEqual(orderMembers(two, "h1").map((person) => person.id), ["h2", "h1", "a"]);
    assert.deepEqual(orderMembers(two, "a").map((person) => person.id), ["h1", "h2", "a"]);
  });

  it("a stranger to the list changes nothing but the teacher", () => {
    assert.equal(ids(""), "habvc");
    assert.deepEqual(orderMembers([], "a"), []);
  });

  it("does not touch the list it was given", () => {
    const copy = [...people];
    orderMembers(people, "a");
    assert.deepEqual(people, copy);
  });
});

describe("parseCameraSize", () => {
  it("keeps a known size and falls back to the default", () => {
    for (const size of CAMERA_SIZES) assert.equal(parseCameraSize(size), size);
    for (const raw of [null, undefined, "", "xl", "M", 2]) assert.equal(parseCameraSize(raw), DEFAULT_CAMERA_SIZE);
  });
});
