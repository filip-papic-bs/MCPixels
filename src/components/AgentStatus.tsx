import { memo } from "react";
import type { WebMcpStatus } from "../editor/EditorProvider.tsx";

export function statusTextFor(status: WebMcpStatus, toolCount: number) {
  return {
    checking: "Checking WebMCP",
    ready: `${toolCount} agent tools ready`,
    working: "Agent working",
    unavailable: "Best in ChatGPT browser",
    error: "Tool registration failed",
  }[status];
}

export const AgentStatus = memo(function AgentStatus({
  status,
  toolCount,
  onExplain,
}: {
  status: WebMcpStatus;
  toolCount: number;
  onExplain: () => void;
}) {
  const label = statusTextFor(status, toolCount);
  const className = `agent-status agent-status--${status}`;

  return (
    <button
      type="button"
      className={`${className} agent-status--button`}
      title="Open the agent guide"
      aria-haspopup="dialog"
      onClick={onExplain}
    >
      <span aria-hidden="true" />
      {label}
    </button>
  );
});
