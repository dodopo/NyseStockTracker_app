/**
 * Small dependency-free donut chart (SVG). Each slice is a circle stroke with a
 * dash of its share; the center can show a label (e.g. the total).
 */
export type DonutSlice = { key: string; label: string; pct: number; color: string };

export function Donut({
  slices,
  size = 180,
  thickness = 26,
  center,
  ariaLabel,
}: {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
  center?: React.ReactNode;
  ariaLabel: string;
}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={ariaLabel}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={thickness} />
          {slices.map((s) => {
            const len = (s.pct / 100) * c;
            // a 1 px gap between slices, except when there is only one
            const dash = slices.length > 1 ? Math.max(len - 1, 0) : len;
            const el = (
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-offset}
              >
                <title>{`${s.label}: ${s.pct.toFixed(1)}%`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
        </g>
      </svg>
      {center && <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">{center}</div>}
    </div>
  );
}
