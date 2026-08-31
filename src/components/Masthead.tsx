import { memo } from "react";
import type { SelectionBounds } from "../pixels.ts";
import type { Notice, NoticeLogEntry } from "../editor/constants.tsx";
import type { WebMcpStatus } from "../editor/EditorProvider.tsx";
import { AgentStatus } from "./AgentStatus.tsx";
import { NoticeStack } from "./NoticeStack.tsx";

export const Masthead = memo(function Masthead({
  storageError,
  webMcpStatus,
  toolCount,
  notices,
  noticeLog,
  onExplainAgents,
  onJumpTo,
  onClearNoticeLog,
}: {
  storageError: string;
  webMcpStatus: WebMcpStatus;
  toolCount: number;
  notices: Notice[];
  noticeLog: NoticeLogEntry[];
  onExplainAgents: () => void;
  onJumpTo: (bounds: SelectionBounds) => void;
  onClearNoticeLog: () => void;
}) {
  return (
    <header className="masthead">
      <a className="wordmark" href="/" aria-label="MCPixels home">
        <span className="wordmark-mcp">MCP</span>
        <span className="wordmark-tail">ixels</span>
      </a>
      <div className="masthead-status">
        {storageError ? (
          <div className="save-warning" role="status" title={storageError}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2.5 14.5 13.5h-13zM8 6.5v3.5M8 11.8v.7" />
            </svg>
            Not saved
          </div>
        ) : null}
        <AgentStatus
          status={webMcpStatus}
          toolCount={toolCount}
          noticeLog={noticeLog}
          onExplain={onExplainAgents}
          onJumpTo={onJumpTo}
          onClearLog={onClearNoticeLog}
        />
      </div>
      <NoticeStack notices={notices} onJumpTo={onJumpTo} />
    </header>
  );
});
