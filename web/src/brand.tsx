/** Open Runner brand mark — a forward "run" chevron in a rounded tile + wordmark. */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <div className="brand" aria-label="Open Runner">
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
        <defs>
          <linearGradient id="org" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--accent-a)" />
            <stop offset="1" stopColor="var(--accent-b)" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#org)" />
        <path d="M11 9.5 19.5 16 11 22.5" stroke="var(--on-accent)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M18 22.5h4.5" stroke="var(--on-accent)" strokeWidth="3.2" strokeLinecap="round" />
      </svg>
      <div className="brand-text">
        <span className="brand-name">Open Runner</span>
        <span className="brand-sub">Coding agent · open-weight models</span>
      </div>
    </div>
  );
}
