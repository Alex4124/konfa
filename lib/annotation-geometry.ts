import type { AnnotationPayload, Point } from "@/lib/confa-types";

export function translateAnnotation(data: AnnotationPayload, requestedX: number, requestedY: number): { payload: AnnotationPayload; dx: number; dy: number } {
  const coordinates = data.point ? [data.point] : data.points;
  if (!coordinates?.length) throw new Error("У пометки нет координат");

  const xs = coordinates.map(([x]) => x);
  const ys = coordinates.map(([, y]) => y);
  const dx = Number(Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), requestedX)).toFixed(5));
  const dy = Number(Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), requestedY)).toFixed(5));
  const shift = ([x, y]: Point): Point => [
    Number(Math.max(0, Math.min(1, x + dx)).toFixed(5)),
    Number(Math.max(0, Math.min(1, y + dy)).toFixed(5)),
  ];

  return {
    payload: {
      ...data,
      ...(data.point ? { point: shift(data.point) } : {}),
      ...(data.points ? { points: data.points.map(shift) } : {}),
    },
    dx,
    dy,
  };
}
