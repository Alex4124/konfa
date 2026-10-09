import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  accessLevel, accessRoomFromRow, accessRoomFromState, canAnnotate, canAnnotateAfterRoleChange,
  canChangeAnnotation, canModerate, defaultCanAnnotate, isShareOwner, type AccessMember, type AccessRoom,
} from "./annotation-permissions.ts";

const host: AccessMember = { id: "h", role: "host", can_annotate: 0 };
const owner: AccessMember = { id: "s", role: "speaker", can_annotate: 0 };
const speaker: AccessMember = { id: "p", role: "speaker", can_annotate: 1 };
const viewer: AccessMember = { id: "v", role: "viewer", can_annotate: false };
const on: AccessRoom = { annotationsEnabled: true, activeShareOwner: "s" };
const off: AccessRoom = { annotationsEnabled: false, activeShareOwner: "s" };

describe("annotation permissions", () => {
  it("host can annotate and moderate even with the switch off and flag 0", () => {
    assert.equal(canAnnotate(host, off), true);
    assert.equal(canModerate(host, off), true);
    assert.equal(accessLevel(host, off), "host");
  });

  it("share owner annotates and moderates regardless of switch and flag", () => {
    assert.equal(isShareOwner(owner, off), true);
    assert.equal(canAnnotate(owner, off), true);
    assert.equal(canModerate(owner, off), true);
    assert.equal(accessLevel(owner, off), "presenter");
  });

  it("non-owner speaker needs both the switch and the flag", () => {
    assert.equal(canAnnotate(speaker, on), true);
    assert.equal(canAnnotate(speaker, off), false);
    assert.equal(canAnnotate({ ...speaker, can_annotate: 0 }, on), false);
    assert.equal(canModerate(speaker, on), false);
    assert.equal(accessLevel(speaker, on), "allowed");
    assert.equal(accessLevel(speaker, off), "paused");
    assert.equal(accessLevel({ ...speaker, can_annotate: 0 }, on), "denied");
  });

  it("accepts numeric and boolean flags", () => {
    assert.equal(canAnnotate({ ...viewer, can_annotate: true }, on), true);
    assert.equal(canAnnotate({ ...viewer, can_annotate: 1 }, on), true);
    assert.equal(canAnnotate({ ...viewer, can_annotate: false }, on), false);
    assert.equal(canAnnotate({ ...viewer, can_annotate: 0 }, on), false);
  });

  it("null member or room never grants annotation", () => {
    assert.equal(canAnnotate(null, on), false);
    assert.equal(canAnnotate(speaker, null), false);
    assert.equal(canAnnotate(host, undefined), false);
    assert.equal(canModerate(null, on), false);
    assert.equal(isShareOwner(null, on), false);
    assert.equal(isShareOwner(owner, null), false);
    assert.equal(canChangeAnnotation(null, on, "x"), false);
    assert.equal(accessLevel(null, on), "denied");
    assert.equal(accessLevel(speaker, null), "denied");
  });

  it("activeShareOwner null never matches", () => {
    const room: AccessRoom = { annotationsEnabled: false, activeShareOwner: null };
    assert.equal(isShareOwner({ id: "" }, room), false);
    assert.equal(canAnnotate({ ...owner, id: "" }, room), false);
  });

  it("canChangeAnnotation: own marks for annotators, any mark for moderators", () => {
    assert.equal(canChangeAnnotation(speaker, on, "p"), true);
    assert.equal(canChangeAnnotation(speaker, on, "other"), false);
    assert.equal(canChangeAnnotation(speaker, off, "p"), false);
    assert.equal(canChangeAnnotation(host, off, "other"), true);
    assert.equal(canChangeAnnotation(owner, off, "other"), true);
    assert.equal(canChangeAnnotation(viewer, on, "v"), false);
  });

  it("defaultCanAnnotate: only webinar viewers start without the right", () => {
    assert.equal(defaultCanAnnotate("webinar", "viewer"), false);
    assert.equal(defaultCanAnnotate("webinar", "speaker"), true);
    assert.equal(defaultCanAnnotate("webinar", "host"), true);
    assert.equal(defaultCanAnnotate("meeting", "speaker"), true);
    assert.equal(defaultCanAnnotate("meeting", "host"), true);
    assert.equal(defaultCanAnnotate("meeting", "viewer"), true);
  });

  it("canAnnotateAfterRoleChange", () => {
    assert.equal(canAnnotateAfterRoleChange("viewer"), false);
    assert.equal(canAnnotateAfterRoleChange("speaker"), true);
    assert.equal(canAnnotateAfterRoleChange("host"), true);
  });

  it("builds AccessRoom from a D1 row and from state", () => {
    assert.deepEqual(accessRoomFromRow({ annotations_enabled: 1, active_share_owner: "s" }), { annotationsEnabled: true, activeShareOwner: "s" });
    assert.deepEqual(accessRoomFromRow({ annotations_enabled: 0, active_share_owner: null }), { annotationsEnabled: false, activeShareOwner: null });
    assert.deepEqual(accessRoomFromRow({ annotations_enabled: true, active_share_owner: "" }), { annotationsEnabled: true, activeShareOwner: null });
    assert.deepEqual(accessRoomFromState({ annotationsEnabled: false, activeShareOwner: "x" }), { annotationsEnabled: false, activeShareOwner: "x" });
  });
});
