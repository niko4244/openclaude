/**
 * Pip, the OpenClaude mascot: a small teal pixel robot with a spark on its antenna (original artwork).
 * Drawn as an SVG pixel grid; idle it blinks now and then, working it hops, glances around and its
 * spark flickers. All motion stops under prefers-reduced-motion (styles.css).
 */
const GRID = [
  ".......S.......",
  "......SSS......",
  ".......S.......",
  ".......K.......",
  "...KKKKKKKKK...",
  "..KLLLTTTTTTK..",
  ".KLLTTTTTTTTTK.",
  ".KLTEWTTTEWTTK.",
  ".KTTEETTTEETTK.",
  ".KTTTTTTTTTTTK.",
  ".KTTTTKTKTTTTK.",
  ".KDTTTTKTTTTDK.",
  "..KDDTTTTTDDK..",
  "...KKKKKKKKK...",
  "...KK.....KK...",
];

const FILL: Record<string, string> = {
  K: "var(--pip-ink)",
  T: "var(--accent)",
  L: "var(--pip-light)",
  D: "var(--pip-shade)",
  E: "var(--pip-eye)",
  W: "#fff",
  S: "var(--pip-spark)",
};

type Layer = "body" | "eyes" | "spark";
type Run = { x: number; y: number; w: number; c: string };

/** Which pixel each layer paints. The body paints teal under the eyes so a blink shows body, not a hole. */
const PAINT: Record<Layer, (ch: string) => string | null> = {
  body: (ch) => ("KTLD".includes(ch) ? ch : "EW".includes(ch) ? "T" : null),
  eyes: (ch) => ("EW".includes(ch) ? ch : null),
  spark: (ch) => (ch === "S" ? ch : null),
};

/** Horizontal same-color runs per layer (fewer rects than one per pixel). */
const RUNS = Object.fromEntries(
  (Object.keys(PAINT) as Layer[]).map((layer) => {
    const runs: Run[] = [];
    GRID.forEach((row, y) => {
      let run: Run | null = null;
      [...row].forEach((ch, x) => {
        const c = PAINT[layer](ch);
        if (c && run?.c === c) run.w++;
        else run = c ? (runs.push({ x, y, w: 1, c }), runs[runs.length - 1]) : null;
      });
    });
    return [layer, runs];
  }),
) as Record<Layer, Run[]>;

export function Pip({ size = 48, working = false, label }: { size?: number; working?: boolean; label?: string }) {
  return (
    <svg
      className={`pip${working ? " working" : ""}`}
      data-mascot="pip"
      width={size}
      height={size}
      viewBox="0 0 15 15"
      shapeRendering="crispEdges"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g className="pip-all">
        {(["body", "eyes", "spark"] as Layer[]).map((layer) => (
          <g key={layer} className={`pip-${layer}`}>
            {RUNS[layer].map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={FILL[r.c]} />)}
          </g>
        ))}
      </g>
    </svg>
  );
}
