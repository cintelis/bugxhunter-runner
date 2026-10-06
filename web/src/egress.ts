import { useEffect, useState } from "react";

export type Decision = "session" | "always" | "deny";

export interface EgressRequest {
  id: string;
  host: string;
  ports: number[];
  privateAddress: boolean;
  address?: string;
  attempts: number;
  firstSeen: number;
  /** Connections currently held open waiting for the answer. */
  waiting: number;
  /** When the card expires if nobody answers (ms since epoch). */
  expires: number;
}
export interface EgressRule {
  host: string;
  decision: Decision;
  at: number;
}
export interface EgressState {
  /** False when the server runs without the egress proxy (native mode). */
  enabled: boolean;
  pending: EgressRequest[];
  rules: EgressRule[];
}

type EgressEvent =
  | { kind: "snapshot"; enabled: boolean; pending: EgressRequest[]; rules: EgressRule[] }
  | { kind: "pending"; request: EgressRequest }
  | { kind: "resolved"; host: string; decision: Decision }
  | { kind: "rules"; rules: EgressRule[] };

/** Live view of the agent's internet-access requests and the saved rules. */
export function useEgress(): EgressState {
  const [state, setState] = useState<EgressState>({ enabled: false, pending: [], rules: [] });

  useEffect(() => {
    let stopped = false;
    let ctrl: AbortController | null = null;

    async function connect() {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const r = await fetch("/api/egress/events", { signal: ctrl.signal });
          if (!r.ok || !r.body) throw new Error(String(r.status));
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (line.startsWith("data:")) apply(JSON.parse(line.slice(5)) as EgressEvent);
            }
          }
        } catch {
          /* reconnect below */
        }
        if (!stopped) await new Promise((r) => setTimeout(r, 3000));
      }
    }

    function apply(e: EgressEvent) {
      setState((s) => {
        switch (e.kind) {
          case "snapshot":
            return { enabled: e.enabled, pending: e.pending, rules: e.rules };
          case "pending": {
            const rest = s.pending.filter((p) => p.host !== e.request.host);
            const existing = s.pending.find((p) => p.host === e.request.host);
            return { ...s, pending: existing ? s.pending.map((p) => (p.host === e.request.host ? e.request : p)) : [...rest, e.request] };
          }
          case "resolved":
            return { ...s, pending: s.pending.filter((p) => p.host !== e.host) };
          case "rules":
            return { ...s, rules: e.rules };
        }
      });
    }

    connect();
    return () => {
      stopped = true;
      ctrl?.abort();
    };
  }, []);

  return state;
}

export async function egressDecide(host: string, decision: Decision) {
  await fetch("/api/egress/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host, decision }),
  });
}

export async function egressRemoveRule(host: string) {
  await fetch(`/api/egress/rules/${encodeURIComponent(host)}`, { method: "DELETE" });
}
