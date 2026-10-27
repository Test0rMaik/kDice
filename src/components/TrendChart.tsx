/**
 * TrendChart — minimal inline-SVG area chart (sparkline or activity chart).
 *
 * Zero chart-library dependencies: Phase 3 needs sparklines + one area
 * chart, which is far less maintenance than pulling in recharts. `fluid`
 * renders at 100% parent width while `width`/`height` keep the viewBox
 * proportions.
 */
interface TrendChartProps {
  /** Series values (>= 1 entry). */
  values: number[];
  /** ViewBox width (also the fixed rendered width unless `fluid`). */
  width: number;
  /** ViewBox height (also the fixed rendered height unless `fluid`). */
  height: number;
  ariaLabel: string;
  /** Render at 100% of the parent width. */
  fluid?: boolean;
  strokeWidth?: number;
}

export function TrendChart({
  values,
  width,
  height,
  ariaLabel,
  fluid = false,
  strokeWidth = 1.5,
}: TrendChartProps) {
  const max = Math.max(1, ...values);
  const stepX = values.length > 1 ? width / (values.length - 1) : width / 2;
  const pts = values.map((v, i) => {
    const x = values.length > 1 ? i * stepX : width / 2;
    const y = height - 2 - (v / max) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = pts.join(' ');
  const area = `0,${height} ${line} ${width},${height}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={fluid ? undefined : width}
      height={fluid ? undefined : height}
      style={fluid ? { width: '100%', height: 'auto' } : undefined}
      role="img"
      aria-label={ariaLabel}
    >
      <polygon points={area} className="trend__area" />
      {/* pathLength=1 normalizes the dash math so index.css can animate a
          draw-in (stroke-dasharray:1; dashoffset 1→0) regardless of width. */}
      <polyline points={line} className="trend__line" strokeWidth={strokeWidth} pathLength={1} />
    </svg>
  );
}