import { memo, useState } from "react";
import type { CSSProperties } from "react";

const TOOLS: [string, string][] = [
  ["draw_pixel_art", "pictures, shapes, flood fill and mirroring"],
  ["read_canvas", "read any region back in the same format"],
  ["selection", "select, move, copy, paste, flip, rotate"],
  ["edit", "undo, redo, clear the canvas"],
  ["view", "scroll and zoom what you see"],
  ["export_pixel_art", "save a region to your downloads"],
];

const STARTER_PROMPT =
  "Draw a 16 by 16 orange mushroom near the center. Duplicate it 24 pixels to the right, recolor the copy blue, then export both as one PNG.";

const DEMO_ROWS = [
  "....................",
  "...oooo.......bbbb..",
  "..oooooo.....bbbbbb.",
  "..okooko.....bkbbkb.",
  "...kkkk.......kkkk..",
  "...kcck.......kcck..",
  "...kcck.......kcck..",
  "..kkkkkk.....kkkkkk.",
];

const DEMO_CELLS = DEMO_ROWS.flatMap((row, y) =>
  [...row].map((color, x) => ({
    color,
    key: `${x}-${y}`,
    delay: `${(x < 10 ? y * 4 + x : 54 + y * 4 + x - 10) * 24}ms`,
  })),
);

export const AgentHelpDialog = memo(function AgentHelpDialog({ onClose }: { onClose: () => void }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  const copyStarterPrompt = async () => {
    try {
      await navigator.clipboard.writeText(STARTER_PROMPT);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <div
      className="export-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="export-panel agent-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-help-title"
        tabIndex={-1}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="export-header">
          <div>
            <span>WebMCP co-editing</span>
            <h2 id="agent-help-title">Draw with an agent</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="agent-demo" aria-hidden="true">
          <div className="agent-demo-bar">
            <span>Live canvas</span>
            <strong>
              <i /> Agent drawing
            </strong>
          </div>
          <div className="agent-demo-canvas">
            <div className="agent-demo-grid">
              {DEMO_CELLS.map((cell) => (
                <span
                  key={cell.key}
                  className={cell.color === "." ? "" : `agent-demo-pixel agent-demo-pixel--${cell.color}`}
                  style={cell.color === "." ? undefined : ({ "--paint-delay": cell.delay } as CSSProperties)}
                />
              ))}
            </div>
            <span className="agent-demo-cursor">
              <i />
              agent
            </span>
          </div>
        </div>

        <p className="agent-help-lead">
          MCPixels gives an AI agent the same canvas you are drawing on. It can draw, rearrange and export while you
          watch, and you can keep editing at the same time.
        </p>

        <section className="agent-prompt" aria-labelledby="agent-prompt-title">
          <div className="agent-help-section-heading">
            <span id="agent-prompt-title">Starter prompt</span>
            <button type="button" onClick={() => void copyStarterPrompt()}>
              {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy prompt"}
            </button>
          </div>
          <p>{STARTER_PROMPT}</p>
        </section>

        <section className="agent-help-section" aria-labelledby="agent-tools-title">
          <div className="agent-help-section-heading">
            <span id="agent-tools-title">Six site tools</span>
          </div>
          <ul className="agent-help-tools">
            {TOOLS.map(([name, what]) => (
              <li key={name}>
                <code>{name}</code>
                <span>{what}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="agent-help-section" aria-labelledby="agent-setup-title">
          <div className="agent-help-section-heading">
            <span id="agent-setup-title">Turn it on</span>
          </div>
          <ul className="agent-help-steps">
            <li>
              Open this page in the <strong>ChatGPT desktop app's built-in browser</strong>, then check{" "}
              <strong>Site tools</strong> in the address bar.
            </li>
            <li>
              In <strong>Chrome 149+</strong>, enable <code>chrome://flags/#enable-webmcp-testing</code> and reload.
            </li>
          </ul>
        </section>
      </section>
    </div>
  );
});
