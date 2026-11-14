import { useSyncExternalStore } from "react";

/** Whether a media query matches, updated when it changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}

/** Tailwind's `md` breakpoint: the full header and tables from here up. */
export const useIsDesktop = () => useMediaQuery("(min-width: 768px)");
