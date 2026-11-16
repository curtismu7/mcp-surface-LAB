import GatewayTrace from "../gateway-trace/GatewayTrace";

// Replaces the shared panel's sentence about what kind of gateway this is (its default says Real mode shows the actual gateway, which is wrong here).
const BASIS_NOTE = "In this lab, Real means its own local engine, not a Ping gateway: the decisions below are the ones that engine computed. The lab does not model the credential an agent sends, so the Authorization line names the caller instead.";

// "What Privilege did" (Rule 25), under the Last action panel: the gateway call the last mcp action made, with the request, the answer and the decisions in between.
// Nothing is drawn until an mcp action has run. This lab has no real gateway: its Real mode is its own local engine, so the source is always "mock" and every decision
// was computed by that engine (checked), never read from a real gateway.
export default function GatewayTracePanel({ last }) {
  if (!last || last.op !== "mcp" || !last.trace) return null;
  const t = last.trace;
  const exchanges = [{ step: 1, title: `Agent to gateway: ${t.request?.body?.method ?? "call"}`, status: t.response?.status ?? null, trace: t }];
  return (
    <div data-testid="gateway-trace-panel">
      <GatewayTrace exchanges={exchanges} source="mock" basisNote={BASIS_NOTE} />
    </div>
  );
}
