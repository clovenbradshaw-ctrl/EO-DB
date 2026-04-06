import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1024;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT,
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    setIsMobile(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}

/** Returns true for screens between mobile (768px) and tablet (1024px) breakpoints */
export function useIsTablet(): boolean {
  const [isTablet, setIsTablet] = useState(
    () => typeof window !== 'undefined' &&
      window.innerWidth > MOBILE_BREAKPOINT &&
      window.innerWidth <= TABLET_BREAKPOINT,
  );

  useEffect(() => {
    const mql = window.matchMedia(
      `(min-width: ${MOBILE_BREAKPOINT + 1}px) and (max-width: ${TABLET_BREAKPOINT}px)`,
    );
    const handler = (e: MediaQueryListEvent) => setIsTablet(e.matches);
    mql.addEventListener('change', handler);
    setIsTablet(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isTablet;
}

/** Returns true for screens at or below the tablet breakpoint (1024px) */
export function useIsNarrow(): boolean {
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= TABLET_BREAKPOINT,
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${TABLET_BREAKPOINT}px)`);
    const handler = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mql.addEventListener('change', handler);
    setIsNarrow(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isNarrow;
}
