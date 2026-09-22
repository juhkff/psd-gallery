/**
 * LiquidGlass - the one component every translucent surface goes through.
 *
 * It owns the layering contract so surfaces cannot get it wrong:
 *
 *   <div class="liquid-glass ...">      the pane: tint, blur, rim, shadow
 *     {children}                        your content
 *     <i class="liquid-sheen" />        the slow moving film (z 3)
 *     <i class="liquid-specular" />     the pointer highlight (z 4)
 *   </div>
 *
 * Rules that matter:
 *  - content must sit above the sheen, so children are wrapped in a z-1 stack;
 *  - the sheen/specular layers are `pointer-events: none`, so they never eat a
 *    click or a hover;
 *  - pass `as="section"` etc. rather than nesting an extra div when the surface
 *    is semantic.
 *
 * Keep `refract` for large, mostly-static chrome only (the sticky nav). The SVG
 * displacement filter is expensive, and on a scrolling grid of dozens of cards
 * it drops frames for an effect nobody can see at that size.
 */
import type { ElementType, ReactNode } from 'react';

export type GlassVariant = 'pane' | 'thin' | 'none';

export interface LiquidGlassProps {
  children?: ReactNode;
  className?: string;
  /** Which pane treatment to apply. */
  variant?: GlassVariant;
  /** Add the volumetric drop shadow (use for floating chrome). */
  elevate?: boolean;
  /** Use the SVG refraction filter. Large static surfaces only. */
  refract?: boolean;
  /** Show the slow moving sheen. */
  sheen?: boolean;
  /** Enable the pointer-tracked specular (adds the `.liquid-interactive` class). */
  interactive?: boolean;
  as?: ElementType;
  [key: string]: unknown;
}

export function LiquidGlass({
  children,
  className = '',
  variant = 'pane',
  elevate = false,
  refract = false,
  sheen = true,
  interactive = false,
  as,
  ...rest
}: LiquidGlassProps) {
  const Tag = (as ?? 'div') as ElementType;
  const classes = [
    variant === 'pane' ? 'liquid-glass' : variant === 'thin' ? 'liquid-glass-thin' : '',
    elevate ? 'liquid-elevate' : '',
    refract ? 'liquid-refract' : '',
    interactive ? 'liquid-interactive' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag className={classes} {...rest}>
      {children != null && <div className="relative z-[1] min-w-0">{children}</div>}
      {sheen && <i aria-hidden="true" className="liquid-sheen" />}
      {interactive && <i aria-hidden="true" className="liquid-specular" />}
    </Tag>
  );
}

export default LiquidGlass;
