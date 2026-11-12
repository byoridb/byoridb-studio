import { useEffect, type RefObject } from "react";

const CONTROLS = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Takes the controls of `surface` that lie under `cover` out of the tab order and
 * away from the pointer (`inert`), and gives them back when called again or when
 * the returned function runs. A control counts as covered when its centre is: one
 * that only touches the cover's edge can still be seen and used.
 */
export function coverControls(surface: HTMLElement, cover: HTMLElement): { update: () => void; release: () => void } {
  const covered = new Set<HTMLElement>();
  const update = () => {
    const over = cover.getBoundingClientRect();
    const hides = (rect: DOMRect) => {
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      return rect.width > 0 && rect.height > 0 &&
        x >= over.left && x <= over.right && y >= over.top && y <= over.bottom;
    };
    for (const control of surface.querySelectorAll<HTMLElement>(CONTROLS)) {
      const mine = covered.has(control);
      // Inside something already inert (the inspector under the drawer): nothing to add.
      if (!mine && control.closest("[inert]")) continue;
      const under = over.width > 0 && hides(control.getBoundingClientRect());
      if (under && !mine) {
        control.setAttribute("inert", "");
        covered.add(control);
      } else if (!under && mine) {
        control.removeAttribute("inert");
        covered.delete(control);
      }
    }
    for (const control of covered) if (!control.isConnected) covered.delete(control);
  };
  const release = () => {
    for (const control of covered) control.removeAttribute("inert");
    covered.clear();
  };
  return { update, release };
}

/**
 * While `active` (the assistant drawer floats over the editing surface), whatever
 * the drawer hides cannot be focused or clicked: the part of the player, the
 * timeline and its toolbar that is under it. Followed as the window is resized, the
 * timeline scrolls and controls come and go.
 */
export function useCoveredInert(
  surface: RefObject<HTMLElement | null>,
  /** The element floating over the surface, looked up when the effect runs. */
  cover: () => HTMLElement | null | undefined,
  active: boolean,
  /**
   * Changes whenever `surface` or the cover may have become another element while
   * `active` stayed true (the editing surface is unmounted for the home screen and
   * mounted again with the drawer still open): the new one is covered then.
   */
  mounted: unknown = null,
) {
  useEffect(() => {
    const root = surface.current, over = active ? cover() : null;
    if (!root || !over) return;
    const { update, release } = coverControls(root, over);
    let frame = 0;
    const schedule = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    update();
    const observer = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
    observer?.observe(root, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    root.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      root.removeEventListener("scroll", schedule, true);
      release();
    };
  }, [active, mounted]);
}
