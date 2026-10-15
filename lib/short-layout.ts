// The room's landscape-phone layout (no header, the footer as a rail on the right, the toolbar as a column) for a window at
// most 520 px tall. The on-screen keyboard takes height too (app/layout: interactive-widget=resizes-content): while a text
// field holds it, a height change at the same width is the keyboard, not the window, and the layout stays. Turning the device
// changes the width and decides again.
export const SHORT_QUERY = "(max-height: 520px)";

export type ShortState = Readonly<{ short: boolean; width: number }>;

export function nextShort(state: ShortState, seen: { matches: boolean; width: number; held: boolean }): ShortState {
  if (seen.held && seen.width === state.width) return state;
  return seen.matches === state.short && seen.width === state.width ? state : { short: seen.matches, width: seen.width };
}
