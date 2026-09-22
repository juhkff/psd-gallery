/**
 * Pointer-tracked specular highlight.
 *
 * Writes `--mx` / `--my` (pixels, relative to the element) onto the node so the
 * `.liquid-specular` layer can place its radial highlight without React ever
 * re-rendering - a pointer-move handler that calls setState would re-render the
 * whole gallery on every mouse movement.
 *
 * Listens on the container (not each card) and uses one rAF-throttled handler.
 */
import { useCallback, useEffect, useRef } from 'react';

export interface LiquidPointerOptions {
  /** Skip tracking entirely (e.g. coarse pointers, where there is no hover). */
  disabled?: boolean;
}

export function useLiquidPointer<T extends HTMLElement>(options: LiquidPointerOptions = {}) {
  const ref = useRef<T | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<{ node: HTMLElement; x: number; y: number } | null>(null);

  const flush = useCallback(() => {
    frame.current = null;
    const next = pending.current;
    if (!next) return;
    const rect = next.node.getBoundingClientRect();
    next.node.style.setProperty('--mx', `${Math.round(next.x - rect.left)}px`);
    next.node.style.setProperty('--my', `${Math.round(next.y - rect.top)}px`);
    pending.current = null;
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<T>) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('.liquid-interactive');
      if (!target) return;
      pending.current = { node: target, x: event.clientX, y: event.clientY };
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    },
    [flush],
  );

  useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      pending.current = null;
    };
  }, []);

  // A coarse pointer never hovers, so the highlight would just sit at its
  // default. Headless Chrome reports `(hover: hover)` as FALSE, which would make
  // this effect unverifiable in CI, so an explicit override exists:
  //   ?liquid=1  force on   (used by scripts/liquid-check.ts)
  //   ?liquid=0  force off  (used by anyone debugging without the effect)
  const override = readOverride();
  const hoverable =
    !options.disabled &&
    override !== false &&
    (override === true || supportsHover());

  return {
    ref,
    ...(hoverable ? { onPointerMove } : {}),
  };
}

/** null = no override, true/false = forced by the `liquid` query param. */
function readOverride(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = new URLSearchParams(window.location.search).get('liquid');
    if (value === '1' || value === 'on') return true;
    if (value === '0' || value === 'off') return false;
    return null;
  } catch {
    return null;
  }
}

function supportsHover(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(hover: hover)').matches
    : false;
}

export default useLiquidPointer;
