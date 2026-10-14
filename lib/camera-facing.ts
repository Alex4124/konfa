// Front or back camera on a phone or a tablet. The camera is picked by facingMode, not by device: a phone lists up to
// four back cameras, and their names are in the system's language.

export type Facing = "user" | "environment";
export const DEFAULT_FACING: Facing = "user";

export function oppositeFacing(facing: Facing): Facing {
  return facing === "user" ? "environment" : "user";
}

// The button says which camera it turns on.
export function flipLabel(facing: Facing): string {
  return facing === "user" ? "Включить заднюю камеру" : "Включить переднюю камеру";
}

export function countCameras(devices: readonly Pick<MediaDeviceInfo, "kind">[]): number {
  return devices.filter((device) => device.kind === "videoinput").length;
}

// Phone browsers cannot share a screen: there the share button only led to an error.
export function supportsScreenShare(scope: object = globalThis): boolean {
  const media = (scope as { navigator?: { mediaDevices?: { getDisplayMedia?: unknown } } }).navigator?.mediaDevices;
  return typeof media?.getDisplayMedia === "function";
}
