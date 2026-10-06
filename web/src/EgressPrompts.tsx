import { useEffect, useState } from "react";
import { egressDecide, type EgressRequest } from "./egress";

/** Approval cards for hosts the agent is trying to reach. */
export function EgressPrompts({ pending }: { pending: EgressRequest[] }) {
  if (!pending.length) return null;
  return (
    <div className="egress-stack">
      {pending.map((p) => <EgressCard key={p.host} req={p} />)}
    </div>
  );
}

function EgressCard({ req }: { req: EgressRequest }) {
  const [busy, setBusy] = useState(false);
  const now = useNow();
  const ports = req.ports.filter((p) => p !== 443 && p !== 80);
  const minsLeft = Math.max(1, Math.ceil((req.expires - now) / 60_000));

  async function choose(decision: "session" | "always" | "deny") {
    setBusy(true);
    await egressDecide(req.host, decision).catch(() => setBusy(false));
  }

  return (
    <div className={"egress-card" + (req.privateAddress ? " private" : "")} role="alertdialog" aria-label={`Allow internet access to ${req.host}?`}>
      <div className="egress-main">
        <div className="egress-title">
          <span className="egress-globe" aria-hidden>🌐</span>
          Allow the agent to connect to <b className="mono">{req.host}</b>{ports.length ? <span className="mono">:{ports.join(", ")}</span> : null}?
        </div>
        <div className="egress-sub">
          {req.privateAddress && (
            <span className="warn">⚠ Private address {req.address} — your local network, Docker or this computer, not the internet. </span>
          )}
          {req.waiting > 0
            ? <span className="live-dot">agent is waiting</span>
            : <span>the agent stopped waiting — approve, then ask it to retry</span>}
          <span className="egress-timer"> · {req.attempts} attempt{req.attempts > 1 ? "s" : ""} · expires in {minsLeft} min</span>
        </div>
      </div>
      <div className="egress-actions">
        <button className="btn primary sm" disabled={busy} onClick={() => choose("session")}>Allow this session</button>
        <button className="btn sm" disabled={busy} onClick={() => choose("always")}>Always allow</button>
        <button className="btn sm danger-outline" disabled={busy} onClick={() => choose("deny")}>Deny</button>
      </div>
    </div>
  );
}

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
