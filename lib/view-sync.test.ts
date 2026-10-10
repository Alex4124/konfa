import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fakeClock } from "./fake-clock.ts";
import { createViewReceiver, createViewSender, nextStamp, parseViewPacket, sameSnapshot, VIEW_HEARTBEAT_MS, VIEW_SEND_MS, type ViewPacket, type ViewSnapshot } from "./view-sync.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";
const packet = (over: Partial<ViewPacket> = {}): ViewPacket => ({ v: 1, ws: WS, epoch: 1000, seq: 1, board: { pos: 2.5, span: 0.6, at: 10 }, ...over });
const decode = (data: Uint8Array) => JSON.parse(new TextDecoder().decode(data)) as ViewPacket;

describe("parseViewPacket", () => {
  it("accepts board and doc parts and drops unknown fields", () => {
    const parsed = parseViewPacket({ ...packet({ doc: { id: DOC, pos: 3.25, span: 1.4, at: 12 } }), extra: 1 });
    assert.deepEqual(parsed, { v: 1, ws: WS, epoch: 1000, seq: 1, board: { pos: 2.5, span: 0.6, at: 10 }, doc: { id: DOC, pos: 3.25, span: 1.4, at: 12 } });
    assert.deepEqual(parseViewPacket({ v: 1, ws: WS, epoch: 5, seq: 0 }), { v: 1, ws: WS, epoch: 5, seq: 0 });
  });

  it("rejects malformed packets", () => {
    for (const bad of [null, "x", [], { ...packet(), v: 2 }, { ...packet(), ws: "" }, { ...packet(), seq: -1 }, { ...packet(), epoch: "now" },
      { ...packet(), board: { pos: -1, span: 1, at: 1 } }, { ...packet(), board: { pos: 1, span: 0, at: 1 } }, { ...packet(), board: { pos: Number.NaN, span: 1, at: 1 } },
      { ...packet(), board: { pos: 1, span: 1 } }, { ...packet(), board: { pos: 1, span: 1, at: -1 } },
      { ...packet(), doc: { pos: 1, span: 1, at: 1 } }, { ...packet(), doc: { id: "", pos: 1, span: 1, at: 1 } }, { ...packet(), board: "top" }]) {
      assert.equal(parseViewPacket(bad), null, JSON.stringify(bad));
    }
  });
});

describe("view receiver", () => {
  it("takes a sender's packets in order only: later seq of the same epoch, or a later epoch", () => {
    const receiver = createViewReceiver();
    assert.equal(receiver.accept("laptop", packet({ seq: 5 }), 0), true);
    assert.equal(receiver.accept("laptop", packet({ seq: 4 }), 10), false, "an older lossy packet");
    assert.equal(receiver.accept("laptop", packet({ seq: 5 }), 10), false);
    assert.equal(receiver.accept("laptop", packet({ seq: 6 }), 20), true);
    assert.equal(receiver.accept("laptop", packet({ epoch: 2000, seq: 1 }), 30), true, "the teacher reloaded");
    assert.equal(receiver.accept("laptop", packet({ epoch: 1000, seq: 99 }), 40), false, "a straggler of the old session");
    assert.equal(receiver.accept("tablet", packet({ epoch: 500, seq: 1 }), 50), true, "another device has its own order");
  });

  it("the device that moved a part last leads it, whichever joined last", () => {
    const receiver = createViewReceiver();
    receiver.accept("laptop", packet({ epoch: 1000, board: { pos: 0, span: 0.6, at: 100 } }), 0);
    receiver.accept("tablet", packet({ epoch: 2000, board: { pos: 9, span: 1.2, at: 50 } }), 10);
    assert.deepEqual(receiver.lead("board", WS), { pos: 0, span: 0.6, at: 100, sender: "laptop", heard: 0 }, "the tablet joined later but has not been moved since");
    receiver.accept("tablet", packet({ epoch: 2000, seq: 2, board: { pos: 9.5, span: 1.2, at: 101 } }), 20);
    assert.equal(receiver.lead("board", WS)?.sender, "tablet");
    // The laptop's heartbeat repeats its old place with its old stamp: it does not take the lead back.
    receiver.accept("laptop", packet({ epoch: 1000, seq: 2, board: { pos: 0, span: 0.6, at: 100 } }), 30);
    assert.deepEqual(receiver.lead("board", WS), { pos: 9.5, span: 1.2, at: 101, sender: "tablet", heard: 20 });
    assert.equal(receiver.newest(), 101);
  });

  it("each part has its own leader; a part of another workspace or material is not followed", () => {
    const receiver = createViewReceiver();
    receiver.accept("laptop", packet({ board: { pos: 1, span: 1, at: 5 }, doc: { id: DOC, pos: 7, span: 1, at: 9 } }), 0);
    receiver.accept("tablet", packet({ board: { pos: 4, span: 1, at: 8 }, doc: { id: DOC, pos: 2, span: 1, at: 3 } }), 0);
    assert.equal(receiver.lead("board", WS)?.pos, 4);
    assert.equal(receiver.lead("doc", WS, DOC)?.pos, 7);
    assert.equal(receiver.lead("doc", WS, "other"), null);
    assert.equal(receiver.lead("doc", WS), null);
    assert.equal(receiver.lead("board", "another-workspace"), null);
  });

  it("equal stamps keep a fixed leader; a device that left stops leading", () => {
    const receiver = createViewReceiver();
    receiver.accept("b", packet({ board: { pos: 3, span: 1, at: 0 } }), 0);
    receiver.accept("a", packet({ board: { pos: 3, span: 2, at: 0 } }), 5);
    assert.equal(receiver.lead("board", WS)?.sender, "a");
    receiver.accept("b", packet({ seq: 2, board: { pos: 3, span: 1, at: 0 } }), 9);
    assert.equal(receiver.lead("board", WS)?.sender, "a", "a later heartbeat does not flip it");
    receiver.forget("a");
    assert.equal(receiver.lead("board", WS)?.sender, "b");
    receiver.forget("b");
    assert.equal(receiver.lead("board", WS), null);
  });

  it("a new move is stamped after everything seen, whatever the clocks say", () => {
    assert.equal(nextStamp(5000.7, 100), 5000);
    assert.equal(nextStamp(5000, 9000), 9001, "the other device's clock runs ahead");
    assert.equal(nextStamp(0, 0), 1);
  });
});

describe("view sender", () => {
  function setup() {
    const clock = fakeClock();
    const sent: Array<{ packet: ViewPacket; reliable: boolean }> = [];
    const sender = createViewSender({ publish: (data, reliable) => { sent.push({ packet: decode(data), reliable }); }, now: clock.now, timers: clock.host, epoch: 77 });
    return { clock, sent, sender };
  }
  const at = (pos: number, stamp = 1): ViewSnapshot => ({ ws: WS, board: { pos, span: 0.6, at: stamp } });

  it("sends the first change at once, then at most one lossy packet per interval with the newest position", () => {
    const { clock, sent, sender } = setup();
    sender.update(at(1));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].reliable, false);
    assert.deepEqual([sent[0].packet.epoch, sent[0].packet.seq, sent[0].packet.board?.pos, sent[0].packet.board?.at], [77, 1, 1, 1]);
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

  it("a press on a part that does not move it still goes out: this device takes the lead where it is", () => {
    const { clock, sent, sender } = setup();
    sender.update(at(4, 1), true);
    clock.advance(VIEW_SEND_MS);
    sender.update(at(4, 2), true);
    clock.advance(VIEW_SEND_MS);
    assert.deepEqual(sent.map((item) => [item.packet.board?.pos, item.packet.board?.at, item.reliable]), [[4, 1, true], [4, 2, true]]);
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

  it("sameSnapshot compares parts, stamps and the document", () => {
    assert.equal(sameSnapshot(at(1), at(1)), true);
    assert.equal(sameSnapshot(at(1), at(1.5)), false);
    assert.equal(sameSnapshot(at(1, 1), at(1, 2)), false);
    assert.equal(sameSnapshot({ ws: WS, doc: { id: DOC, pos: 1, span: 1, at: 1 } }, { ws: WS, doc: { id: "other", pos: 1, span: 1, at: 1 } }), false);
    assert.equal(sameSnapshot(at(1), { ws: WS }), false);
    assert.equal(sameSnapshot(null, null), true);
    assert.equal(sameSnapshot(at(1), null), false);
  });
});
