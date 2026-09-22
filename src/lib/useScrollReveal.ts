/**
 * Scroll reveal driver.
 *
 * One IntersectionObserver for the whole page, shared by every `.reveal` node.
 * The optimistic part matters: `<html>` only gets `.reveal-ready` (which is what
 * actually hides the content) AFTER we know the observer exists, so with JS
 * disabled or an unsupported browser the page renders fully visible instead of
 * blank. `index.css` handles the reduced-motion case.
 */

import { useEffect } from 'react';

const READY_CLASS = 'reveal-ready';
const VISIBLE_CLASS = 'is-visible';

export interface ScrollRevealOptions {
  /** Fraction of the viewport a node must enter before it reveals. */
  threshold?: number;
  /** Reveal things slightly before they reach the edge. */
  rootMargin?: string;
}

export function useScrollReveal(options: ScrollRevealOptions = {}): void {
  const { threshold = 0.08, rootMargin = '0px 0px -8% 0px' } = options;

  useEffect(() => {
    const root = document.documentElement;

    // Anything already on screen at mount reveals immediately; nodes added
    // later (pagination, route changes) are picked up by the MutationObserver.
    const reveal = (node: Element) => {
      node.classList.add(VISIBLE_CLASS);
      // Drop the promotion hint once the animation is done. Leaving
      // `will-change: transform` on an element keeps a containing block alive
      // and permanently affects how descendants are positioned and scrolled.
      (node as HTMLElement).style.willChange = 'auto';
    };

    if (typeof IntersectionObserver === 'undefined') {
      // No observer support: leave everything visible.
      return;
    }

    root.classList.add(READY_CLASS);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          reveal(entry.target);
          observer.unobserve(entry.target); // reveal once; no re-hiding
        }
      },
      { threshold, rootMargin },
    );

    const observeAll = () => {
      for (const node of document.querySelectorAll(`.reveal:not(.${VISIBLE_CLASS})`)) {
        observer.observe(node);
      }
    };

    observeAll();

    // Pagination and route changes mount new `.reveal` nodes.
    const mutations = new MutationObserver(() => observeAll());
    mutations.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      mutations.disconnect();
      root.classList.remove(READY_CLASS);
    };
  }, [threshold, rootMargin]);
}

export default useScrollReveal;
