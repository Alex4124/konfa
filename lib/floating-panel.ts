export type PanelPosition = { x: number; y: number };
export type PanelBounds = { width: number; height: number };

// Keep the whole panel visible. If there is little spare room, split it evenly across both sides.
export function clampFloatingPanel(position: PanelPosition, container: PanelBounds, panel: PanelBounds, margin = 12): PanelPosition {
  const range = (outer: number, inner: number) => {
    const spare = Math.max(0, outer - inner);
    const inset = Math.min(margin, spare / 2);
    return { min: inset, max: spare - inset };
  };
  const horizontal = range(container.width, panel.width);
  const vertical = range(container.height, panel.height);
  return {
    x: Math.min(horizontal.max, Math.max(horizontal.min, position.x)),
    y: Math.min(vertical.max, Math.max(vertical.min, position.y)),
  };
}
