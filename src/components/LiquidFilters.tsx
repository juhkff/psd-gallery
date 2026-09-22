/**
 * SVG filters that give the glass its liquid character.
 *
 * `backdrop-filter: url(#id)` lets an SVG filter read the backdrop, which is how
 * a pane can actually *displace* what is behind it instead of only blurring it -
 * that displacement is what reads as refraction rather than frosted plastic.
 *
 * Two filters:
 *   - `liquid-displace` is the refraction. It displaces by an uneven turbulence
 *     field so the wobble is not uniform (a single octave looks like a warped
 *     JPEG, not like glass).
 *   - `liquid-goo` is a thresholded blur for merging blobs.
 *
 * NOTE: filter primitive attributes such as `scale` cannot read CSS custom
 * properties - `scale="var(--x)"` silently fails, so the strengths are constants
 * here. `scripts/liquid-check.ts` verifies the filter actually renders and
 * reports the strength in use, so this stays honest rather than aspirational.
 */
export const DISPLACE_STRENGTH = 16;
export const DISPLACE_DETAIL = 6;

export function LiquidFilters() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
    >
      <defs>
        {/* The two turbulence fields use deliberately mismatched frequencies:
            where they disagree the displacement varies, which is what sells it. */}
        <filter id="liquid-displace" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.008 0.014"
            numOctaves="2"
            seed="7"
            result="noiseA"
          />
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.021 0.006"
            numOctaves="1"
            seed="19"
            result="noiseB"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noiseA"
            scale={DISPLACE_STRENGTH}
            xChannelSelector="R"
            yChannelSelector="G"
            result="bent"
          />
          <feDisplacementMap
            in="bent"
            in2="noiseB"
            scale={DISPLACE_DETAIL}
            xChannelSelector="G"
            yChannelSelector="B"
          />
        </filter>

        <filter id="liquid-goo" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10"
            result="goo"
          />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
      </defs>
    </svg>
  );
}

export default LiquidFilters;
