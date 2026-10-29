import { useMemo } from "react";
import { flagFragments, flagPattern } from "./flags";

/** Plain text (tool output, raw results) with anything matching the flag format marked. */
export function FlagText({ text }: { text: string }) {
  const pattern = flagPattern();
  const pieces = useMemo(() => flagFragments(text, pattern), [text, pattern]);
  if (pieces.length === 1) return <>{text}</>;
  return <>{pieces.map((p, i) => (i % 2 ? <mark key={i} className="flag">{p}</mark> : p))}</>;
}
