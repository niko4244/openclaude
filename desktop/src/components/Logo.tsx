/** OpenClaude mark: an open ring with an inner spark. Original artwork. */
export function Logo({ size = 24, spinning = false }: { size?: number; spinning?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={spinning ? "logo-spin" : undefined} style={{ flexShrink: 0 }}>
      <path d="M16 3a13 13 0 1 0 13 13" fill="none" stroke="var(--accent)" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M16 9.5l1.9 4.6 4.6 1.9-4.6 1.9-1.9 4.6-1.9-4.6-4.6-1.9 4.6-1.9z" fill="var(--accent)" />
    </svg>
  );
}
