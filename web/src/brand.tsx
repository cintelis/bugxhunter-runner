/**
 * BugXHunter brand mark, as on bugxhunter.com: a green `>_` prompt, the
 * wordmark in Fira Code with a red X, and the tagline underneath.
 */
export function Wordmark({ cursor = false }: { cursor?: boolean }) {
  return (
    <>
      <span className="prompt">&gt;_</span>
      <span className="word">Bug<span className="x">X</span>Hunter{cursor && <span className="cursor big" aria-hidden />}</span>
    </>
  );
}

export function Logo({ size = 20, tagline = true }: { size?: number; tagline?: boolean }) {
  return (
    <div className="brand" aria-label="BugXHunter">
      <span className="logo" style={{ fontSize: size }}><Wordmark /></span>
      {tagline && <span className="brand-sub">Open-source AI security testing</span>}
    </div>
  );
}
