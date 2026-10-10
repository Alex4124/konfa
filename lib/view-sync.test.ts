import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fakeClock } from "./fake-clock.ts";
import { createViewReceiver, createViewSender, parseViewPacket, sameSnapshot, VIEW_HEARTBEAT_MS, VIEW_SEND_MS, VIEW_STALE_MS, type ViewPacket, type ViewSnapshot } from "./view-sync.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";
const packet = (over: Partial<ViewPacket> = {}): ViewPacket => ({ v: 1, ws: WS, epoch: 1000, seq: 1, board: { pos: 2.5, span: 0.6 }, ...over });
const decode = (data: Uint8Array) => JSON.parse(new TextDecoder().decode(data)) as ViewPacket;

describe("parseViewPacket", () => {
  it("accepts board and doc parts and drops unknown fields", () => {
    const parsed = parseViewPacket({ ...packet({ doc: { id: DOC, pos: 3.25, span: 1.4 } }), extra: 1 });
    assert.deepEqual(parsed, { v: 1, ws: WS, epoch: 1000, seq: 1, board: { pos: 2.5, span: 0.6 }, doc: { id: DOC, pos: 3.25, span: 1.4 } });
    assert.deepEqual(parseViewPacket({ v: 1, ws: WS, epoch: 5, seq: 0 }), { v: 1, ws: WS, epoch: 5, seq: 0 });
  });

  it("rejects malformed packets", () => {
    for (const bad of [null, "x", [], { ...packet(), v: 2 }, { ...packet(), ws: "" }, { ...packet(), seq: -1 }, { ...packet(), epoch: "now" },
      { ...packet(), board: { pos: -1, span: 1 } }, { ...packet(), board: { pos: 1, span: 0 } }, { ...packet(), board: { pos: Number.NaN, span: 1 } },
      { ...packet(), doc: { pos: 1, span: 1 } }, { ...packet(), doc: { id: "", pos: 1, span: 1 } }, { ...packet(), board: "top" }]) {
      assert.equal(parseViewPacket(bad), null, JSON.stringify(bad));
    }
  });
});

describe("view receiver", () => {
  it("takes packets in order only: later seq of the same epoch, or a later epoch", () => {
    const receiver = createViewReceiver();
    assert.equal(receiver.accept(packet({ seq: 5 }), 0), true);
    assert.equal(receiver.accept(packet({ seq: 4 }), 10), false, "an older lossy packet");
    assert.equal(receiver.accept(packet({ seq: 5 }), 10), false);
    assert.equal(receiver.accept(packet({ seq: 6 }), 20), true);
    assert.equal(receiver.accept(packet({ epoch: 2000, seq: 1 }), 30), true, "the teacher reloaded");
    assert.equal(receiver.accept(packet({ epoch: 1000, seq: 99 }), 40), false, "a straggler of the old session");
    assert.equal(receiver.latest()?.epoch, 2000);
  });

  it("is fresh for a while after the last accepted packet", () => {
    const receiver = createViewReceiver();
    assert.equal(receiver.fresh(0), false);
    receiver.accept(packet(), 100);
    assert.equal(receiver.fresh(100 + VIEW_STALE_MS - 1), true);
    assert.equal(receiver.fresh(100 + VIEW_STALE_MS), false);
  });
});

describe("view sender", () => {
  function setup() {
    const clock = fakeClock();
    const sent: Array<{ packet: ViewPacket; reliable: boolean }> = [];
    const sender = createViewSender({ publish: (data, reliable) => { sent.push({ packet: decode(data), reliable }); }, now: clock.now, timers: clock.host, epoch: 77 });
    return { clock, sent, sender };
  }
  const at = (pos: number): ViewSnapshot => ({ ws: WS, board: { pos, span: 0.6 } });

  it("sends the first change at once, then at most one lossy packet per interval with the newest position", () => {
    const { clock, sent, sender } = setup();
    sender.update(at(1));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].reliable, false);
    assert.deepEqual([sent[0].packet.epoch, sent[0].packet.seq, sent[0].packet.board?.pos], [77, 1, 1]);
    sender.update(at(1.1));
    sender.update(at(1.2));
    sender.update(at(1.3));
    assert.equal(sent.length, 1);
    clock.advance(VIEW_SEND_MS);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].packet.board?.pos, 1.3);
    assert.equal(sent[1].packet.seq, 2);
  });

  it("a settled position goes out reliably, once", () => {
    const { clock, sent, sender } = setup();
    sender.update(at(1));
    sender.update(at(2), true);
    clock.advance(VIEW_SEND_MS);
    assert.deepEqual(sent.map((item) => [item.packet.board?.pos, item.reliable]), [[1, false], [2, true]]);
    sender.update(at(2), true);
    clock.advance(VIEW_SEND_MS);
    assert.equal(sent.length, 2, "nothing new to deliver");
  });

  it("an unchanged position is not resent, but the heartbeat repeats it reliably for late joiners", () => {
    const { clock, sent, sender } = setup();
    sender.update(at(4), true);
    sender.update(at(4));
    clock.advance(VIEW_SEND_MS * 3);
    assert.equal(sent.length, 1);
    clock.advance(VIEW_HEARTBEAT_MS);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].reliable, true);
    assert.equal(sent[1].packet.board?.pos, 4);
    assert.ok(sent[1].packet.seq > sent[0].packet.seq);
  });

  it("stop ends the heartbeat and a pending send; a failing publish does not throw", async () => {
    const clock = fakeClock();
    let calls = 0;
    const sender = createViewSender({ publish: () => { calls++; return Promise.reject(new Error("closed")); }, now: clock.now, timers: clock.host, epoch: 1 });
    sender.update(at(1));
    sender.update(at(2));
    sender.stop();
    clock.advance(VIEW_HEARTBEAT_MS * 2);
    await Promise.resolve();
    assert.equal(calls, 1);
  });

  it("sameSnapshot compares parts and the document", () => {
    assert.equal(sameSnapshot(at(1), at(1)), true);
    assert.equal(sameSnapshot(at(1), at(1.5)), false);
    assert.equal(sameSnapshot({ ws: WS, doc: { id: DOC, pos: 1, span: 1 } }, { ws: WS, doc: { id: "other", pos: 1, span: 1 } }), false);
    assert.equal(sameSnapshot(at(1), { ws: WS }), false);
    assert.equal(sameSnapshot(null, null), true);
    assert.equal(sameSnapshot(at(1), null), false);
  });
});
