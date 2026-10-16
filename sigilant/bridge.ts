// The bridge: an MCP server the agent (OpenCode) talks to as it would any
// other, which puts every call through a Sigilant gateway under the runner's
// own identity. The agent holds no token and never reaches the gateway; the
// bridge lists only the tools the gateway allows the token, and turns what
// the gateway decides into a tool result the model can act on:
//
// | The gateway said | The agent gets |
// |---|---|
// | allowed, and the tool answered | the tool's answer |
// | held for a person | a wait of up to `waitSecs`, then the answer, or that it is still waiting |
// | denied | an error saying so and what to do: re-plan within the scope |
// | the platform could not carry it out | an error saying so: report it, do not look for another route |
// | the token itself refused (revoked, expired) | an error saying to stop |

import { GatewayRefused, type Tool, type ToolOutcome } from "@sigilant/sdk";

import { type McpResult, type McpServer, type McpTool } from "./mcp.ts";

/** What the bridge needs of a gateway client: what `SigilantClient` offers. */
export interface Caller {
  listTools(): Promise<Tool[]>;
  callUntilDecided(
    name: string,
    args: Record<string, unknown>,
    options: { everySecs?: number; signal?: AbortSignal; onPending?: (o: ToolOutcome & { status: "pending" }) => void },
  ): Promise<ToolOutcome>;
}

export interface BridgeOptions {
  /** How long a held call is waited for before the agent is told it is still waiting. */
  waitSecs: number;
  /** How often a held call is retried, which is also how the console gets its card back. */
  everySecs?: number;
  /**
   * How long listing the tools is retried for before giving up: the agent
   * lists them once, at start, which may fall in the minutes after a restart
   * while the issuer's keys reach the gateways. 120 unless set.
   */
  listForSecs?: number;
  /** How often the listing is retried: 5 unless set. */
  listEverySecs?: number;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const text = (t: string): McpResult["content"] => [{ type: "text", text: t }];

/** The gateway's own tool content, where it is text; anything else is said as JSON. */
function contentOf(content: unknown[]): McpResult["content"] {
  const items = content.map((c) => {
    const item = c as { type?: string; text?: string };
    return item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(c);
  });
  return items.length ? items.map((t) => ({ type: "text" as const, text: t })) : text("");
}

export function bridge(caller: Caller, options: BridgeOptions): McpServer {
  const log = options.log ?? (() => {});
  return {
    name: "sigilant-bridge",
    version: "0.1.0",
    async tools(): Promise<McpTool[]> {
      const until = Date.now() + (options.listForSecs ?? 120) * 1000;
      const every = (options.listEverySecs ?? 5) * 1000;
      for (;;) {
        try {
          return (await caller.listTools()).map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? { type: "object" },
          }));
        } catch (why) {
          if (Date.now() + every > until) throw why;
          log(`listing the tools failed (${(why as Error).message}); trying again`);
          await sleep(every);
        }
      }
    },
    async call(name, args): Promise<McpResult> {
      let outcome: ToolOutcome;
      try {
        outcome = await caller.callUntilDecided(name, args, {
          everySecs: options.everySecs ?? 15,
          signal: AbortSignal.timeout(options.waitSecs * 1000),
          onPending: (o) => log(`${name} held for ${o.approvers.join(", ")} (${o.approvalId})`),
        });
      } catch (why) {
        if (why instanceof GatewayRefused) {
          log(`${name} refused outright: ${why.message}`);
          return {
            isError: true,
            content: text(
              why.revoked
                ? `Sigilant has revoked this agent: ${why.message}. Stop: nothing more can be done until a person reinstates it.`
                : `Sigilant would not identify this agent (${why.message}). Stop and report it; no other route will work.`,
            ),
            structuredContent: { sigilant: { decision: "refused", revoked: why.revoked } },
          };
        }
        throw why;
      }
      switch (outcome.status) {
        case "done":
          log(`${name} → ${outcome.isError ? "tool error" : "done"}`);
          return { isError: outcome.isError, content: contentOf(outcome.content), structuredContent: outcome.structuredContent };
        case "pending": {
          const lapses = new Date(outcome.expiresAt * 1000).toISOString();
          log(`${name} → still held after ${options.waitSecs} s (${outcome.approvalId})`);
          return {
            isError: false,
            content: text(
              `${outcome.message} Still waiting after ${options.waitSecs} seconds: a person decides it in the Sigilant console, and the request lapses at ${lapses}. ` +
                "Say that it is waiting for approval, carry on with what does not depend on it, and do not look for another way to do the same thing.",
            ),
            structuredContent: { sigilant: { decision: "step_up", approval_id: outcome.approvalId, approvers: outcome.approvers, expires_at: outcome.expiresAt } },
          };
        }
        case "denied":
          log(`${name} → denied: ${outcome.reason}`);
          return {
            isError: true,
            content: text(outcome.message || `Sigilant denied ${name}: ${outcome.reason}. Re-plan within the engagement's scope; retrying will not help.`),
            structuredContent: { sigilant: { decision: "deny", reason: outcome.reason, detail: outcome.detail } },
          };
        case "failed":
          log(`${name} → failed: ${outcome.reason}`);
          return {
            isError: true,
            content: text(outcome.message || `Sigilant could not carry out ${name}: ${outcome.reason}. Report it; do not look for another route.`),
            structuredContent: { sigilant: { decision: "error", reason: outcome.reason } },
          };
      }
    },
  };
}
