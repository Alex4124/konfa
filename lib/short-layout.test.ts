import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextShort } from "./short-layout.ts";

describe("short layout", () => {
  it("keeps the layout while a field holds the keyboard at the same width", () => {
    const tall = { short: false, width: 390 }, short = { short: true, width: 844 };
    assert.equal(nextShort(tall, { matches: true, width: 390, held: true }), tall);
    assert.equal(nextShort(short, { matches: false, width: 844, held: true }), short);
  });

  it("decides again when the width changes, even while typing", () => {
    assert.deepEqual(nextShort({ short: false, width: 390 }, { matches: true, width: 844, held: true }), { short: true, width: 844 });
    assert.deepEqual(nextShort({ short: true, width: 844 }, { matches: false, width: 390, held: true }), { short: false, width: 390 });
  });

  it("follows the window otherwise", () => {
    assert.deepEqual(nextShort({ short: false, width: 1280 }, { matches: true, width: 1280, held: false }), { short: true, width: 1280 });
    assert.deepEqual(nextShort({ short: true, width: 1280 }, { matches: false, width: 1280, held: false }), { short: false, width: 1280 });
  });

  it("returns the same state when nothing changed", () => {
    const state = { short: true, width: 740 };
    assert.equal(nextShort(state, { matches: true, width: 740, held: false }), state);
  });
});
