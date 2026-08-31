import { memo, useEffect, useId, useRef, useState } from "react";
import type { SelectionBounds } from "../pixels.ts";
import type { NoticeLogEntry } from "../editor/constants.tsx";
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

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

export const AgentStatus = memo(function AgentStatus({
  status,
  toolCount,
  noticeLog,
  onExplain,
  onJumpTo,
  onClearLog,
}: {
  status: WebMcpStatus;
  toolCount: number;
  noticeLog: NoticeLogEntry[];
  onExplain: () => void;
  onJumpTo: (bounds: SelectionBounds) => void;
  onClearLog: () => void;
}) {
  const [open, setOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const entries = [...noticeLog].reverse();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!groupRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      groupRef.current?.querySelector<HTMLButtonElement>(".agent-status-toggle")?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const label = statusTextFor(status, toolCount);

  return (
    <div ref={groupRef} className={`agent-status agent-status--${status}`}>
      <button
        type="button"
        className="agent-status-main"
        title="Open the agent guide"
        aria-haspopup="dialog"
        onClick={onExplain}
      >
        <span className="agent-status-dot" aria-hidden="true" />
        {label}
      </button>
      <button
        type="button"
        className="agent-status-toggle"
        title="Agent tool history"
        aria-label={`Agent tool history, ${noticeLog.length} ${noticeLog.length === 1 ? "entry" : "entries"}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6.5 4 4 4-4" />
        </svg>
      </button>

      {open ? (
        <section id={panelId} className="agent-log" aria-label="Agent tool history">
          <header>
            <span>Tool history</span>
            {entries.length > 0 ? (
              <button type="button" className="agent-log-clear" onClick={onClearLog}>
                Clear
              </button>
            ) : null}
          </header>
          {entries.length === 0 ? (
            <p className="agent-log-empty">Nothing yet. Agent and editor actions show up here.</p>
          ) : (
            <ol className="agent-log-list">
              {entries.map((entry) => {
                const className = `agent-log-item${entry.kind ? ` notice--${entry.kind}` : ""}`;
                const body = (
                  <>
                    <span className="agent-log-time">{CLOCK.format(entry.at)}</span>
                    <span className="agent-log-text">
                      {entry.text}
                      {entry.count > 1 ? <span className="notice-count">×{entry.count}</span> : null}
                    </span>
                  </>
                );

                if (!entry.bounds) {
                  return (
                    <li key={entry.id} className={className}>
                      {body}
                    </li>
                  );
                }
                const bounds = entry.bounds;
                return (
                  <li key={entry.id} className={className}>
                    <button
                      type="button"
                      className="agent-log-jump"
                      aria-label={`${entry.text} Show that area.`}
                      onClick={() => {
                        onJumpTo(bounds);
                        setOpen(false);
                      }}
                    >
                      {body}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
});
