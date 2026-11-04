import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * After client-side navigation, move focus to the main region and scroll to the top so keyboard
 * and screen-reader users land on the new page. Query-string changes (filters) do not move focus.
 */
export function RouteFocus({ targetId }: { targetId: string }) {
  const { pathname, hash } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (hash) return;
    window.scrollTo(0, 0);
    document.getElementById(targetId)?.focus({ preventScroll: true });
  }, [pathname, hash, targetId]);
  return null;
}
