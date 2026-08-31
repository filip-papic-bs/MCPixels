import { memo } from "react";
import type { SelectionBounds } from "../pixels.ts";
import type { Notice } from "../editor/constants.tsx";

/**
 * The feed of agent actions. A notice that knows where it happened is a button
 * that takes the person there; the rest are plain text.
 *
 * The same wording is announced through the editor's live region, so the
 * decorative half of this stack stays out of the accessibility tree while the
 * interactive half keeps a real label.
 */
export const NoticeStack = memo(function NoticeStack({
  notices,
  onJumpTo,
}: {
  notices: Notice[];
  onJumpTo: (bounds: SelectionBounds) => void;
}) {
  if (notices.length === 0) return null;

  return (
    <div className="notice-stack">
      {notices.map((notice) => {
        const className = [
          "notice",
          notice.leaving ? "notice--leaving" : "",
          notice.kind ? `notice--${notice.kind}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        const body = (
          <>
            {notice.text}
            {notice.count > 1 ? <span className="notice-count">×{notice.count}</span> : null}
          </>
        );

        if (!notice.bounds) {
          return (
            <p key={notice.id} className={className} aria-hidden="true">
              {body}
            </p>
          );
        }
        const bounds = notice.bounds;
        return (
          <button
            key={notice.id}
            type="button"
            className={`${className} notice--jump`}
            aria-label={`${notice.text} Show that area.`}
            onClick={() => onJumpTo(bounds)}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
});
