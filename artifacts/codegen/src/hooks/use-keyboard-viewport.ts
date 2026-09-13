import { useEffect } from "react";

const EDITABLE_SELECTOR = "input, textarea, [contenteditable='true']";

export function useKeyboardViewport() {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame: number | null = null;

    const updateInset = () => {
      if (frame !== null) cancelAnimationFrame(frame);

      frame = requestAnimationFrame(() => {
        frame = null;
        const activeElement = document.activeElement;
        const isEditing =
          activeElement instanceof HTMLElement &&
          activeElement.matches(EDITABLE_SELECTOR);
        const viewportHeight = viewport?.height ?? window.innerHeight;
        const keyboardInset = isEditing
          ? Math.max(0, Math.round(window.innerHeight - viewportHeight))
          : 0;

        root.style.setProperty("--keyboard-inset", `${keyboardInset}px`);
      });
    };

    updateInset();
    viewport?.addEventListener("resize", updateInset);
    viewport?.addEventListener("scroll", updateInset);
    window.addEventListener("resize", updateInset);
    window.addEventListener("focusin", updateInset);
    window.addEventListener("focusout", updateInset);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", updateInset);
      viewport?.removeEventListener("scroll", updateInset);
      window.removeEventListener("resize", updateInset);
      window.removeEventListener("focusin", updateInset);
      window.removeEventListener("focusout", updateInset);
      root.style.removeProperty("--keyboard-inset");
    };
  }, []);
}