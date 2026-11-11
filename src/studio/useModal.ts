import { useEffect, useRef } from "react";

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal behaviour shared by every dialog: initial focus, focus trap, Esc to close, focus restore. */
export function useModal<T extends HTMLElement>(
  onClose: () => void,
  canClose = true,
) {
  const ref = useRef<T>(null);
  const state = useRef({ onClose, canClose });
  state.current = { onClose, canClose };
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const items = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(focusable));
    (items()[0] ?? dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (state.current.canClose) state.current.onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const list = items();
      if (!list.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement;
      if (!dialog.contains(current)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, []);
  return ref;
}
