import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Annotation, AnnotationOp } from "@/lib/confa-types";
import { chunk, fitAnnotationOp, idList, MAX_OP_BYTES, parseUuid, placeholders, SQL_IN_CHUNK, utf8Length } from "./annotation-wire.ts";

const A = "0b3c7a52-6f1e-4a8e-9d2f-1c2b3a4d5e6f";
const B = "a1b2c3d4-e5f6-4789-8abc-def012345678";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

describe("parseUuid", () => {
  it("accepts UUIDs, trims and lowercases them", () => {
    assert.equal(parseUuid(A), A);
    assert.equal(parseUuid(` ${B.toUpperCase()} `), B);
  });
  it("rejects anything else", () => {
    for (const value of [undefined, null, 42, "", "abc", `${A}0`, A.replace(/-/g, ""), "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", [A]]) assert.equal(parseUuid(value), null);
  });
});

describe("idList", () => {
  it("normalizes and de-duplicates in input order", () => {
    assert.deepEqual(idList([B, A.toUpperCase(), B, A]), [B, A]);
  });
  it("rejects empty lists, non-arrays and any malformed id", () => {
    assert.equal(idList([]), null);
    assert.equal(idList(A), null);
    assert.equal(idList(undefined), null);
    assert.equal(idList([A, "nope"]), null);
    assert.equal(idList([A, 1]), null);
  });
  it("enforces the maximum length before de-duplication", () => {
    assert.equal(idList(Array.from({ length: 600 }, (_, i) => uuid(i)))?.length, 600);
    assert.equal(idList(Array.from({ length: 601 }, (_, i) => uuid(i))), null);
    assert.equal(idList(Array.from({ length: 601 }, () => A)), null);
    assert.deepEqual(idList([A, B, A], 3), [A, B]);
    assert.equal(idList([A, B, A], 2), null);
  });
});

describe("chunk and placeholders", () => {
  it("splits into SQL-sized chunks", () => {
    const ids = Array.from({ length: 600 }, (_, i) => i);
    const parts = chunk(ids);
    assert.equal(parts.length, Math.ceil(600 / SQL_IN_CHUNK));
    assert.ok(parts.every((part) => part.length <= SQL_IN_CHUNK && part.length > 0));
    assert.deepEqual(parts.flat(), ids);
    assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
    assert.deepEqual(chunk([]), []);
  });
  it("keeps every chunked statement under 100 bound parameters", () => {
    assert.ok(SQL_IN_CHUNK + 6 <= 100);
  });
  it("builds anonymous placeholders", () => {
    assert.equal(placeholders(3), "?, ?, ?");
    assert.equal(placeholders(1), "?");
    assert.equal(placeholders(0), "");
  });
});

describe("fitAnnotationOp", () => {
  const base = { type: "annotations", v: 1, shareId: "share", by: "member" } as const;
  const row = (payload: string): Annotation => ({ id: A, author_id: "member", author_name: "Анна", kind: "pen", payload, created_at: 1, seq: 7 });

  it("passes small ops through unchanged", () => {
    const op: AnnotationOp = { ...base, op: "add", rows: [row("{}")] };
    assert.equal(fitAnnotationOp(op), op);
    const erase: AnnotationOp = { ...base, op: "erase", ids: [A, B] };
    assert.equal(fitAnnotationOp(erase), erase);
  });
  it("replaces oversized ops with resync, measuring UTF-8 bytes", () => {
    const cyrillic = "ж".repeat(4000); // 4000 UTF-16 units, 8000 UTF-8 bytes
    const op: AnnotationOp = { ...base, op: "edit", rows: [row(cyrillic), row(cyrillic)] };
    assert.ok(JSON.stringify(op).length < MAX_OP_BYTES);
    assert.deepEqual(fitAnnotationOp(op), { ...base, op: "resync" });
    const ids: AnnotationOp = { ...base, op: "erase", ids: Array.from({ length: 600 }, (_, i) => uuid(i)) };
    assert.deepEqual(fitAnnotationOp(ids), { ...base, op: "resync" });
  });
  it("honours a custom limit", () => {
    const op: AnnotationOp = { ...base, op: "clear", upToSeq: 10 };
    const size = utf8Length(JSON.stringify(op));
    assert.equal(fitAnnotationOp(op, size), op);
    assert.equal(fitAnnotationOp(op, size - 1).op, "resync");
  });
});
