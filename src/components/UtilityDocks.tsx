import { memo } from "react";
import { useEditorRuntime } from "../editor/EditorProvider.tsx";

export const UtilityDocks = memo(function UtilityDocks({
  hasSelection,
  canUndo,
  canRedo,
  onZoomIn,
  onZoomOut,
}: {
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
}) {
  const { actions, setCanvasMenu, setDockPanel } = useEditorRuntime();
  const dismissPanels = () => {
    setCanvasMenu(null);
    setDockPanel(null);
  };
  const selected = hasSelection ? " utility-dock--selection" : "";

  return (
    <>
      <div
        className={`utility-dock history-dock${selected}`}
        role="toolbar"
        aria-label="History controls"
        onPointerDown={dismissPanels}
      >
        <button
          type="button"
          disabled={!canUndo}
          onClick={() => actions.current.undo()}
          aria-label="Undo"
          title="Undo (Ctrl/Cmd+Z)"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m8 5-4 4 4 4M4 9h6a6 6 0 0 1 6 6" />
          </svg>
        </button>
        <button type="button" disabled={!canRedo} onClick={() => actions.current.redo()} aria-label="Redo" title="Redo">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m12 5 4 4-4 4m4-4h-6a6 6 0 0 0-6 6" />
          </svg>
        </button>
      </div>
      <div
        className={`utility-dock view-dock${selected}`}
        role="toolbar"
        aria-label="View controls"
        onPointerDown={dismissPanels}
      >
        <button type="button" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 10h10" />
          </svg>
        </button>
        <button type="button" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 10h10M10 5v10" />
          </svg>
        </button>
        <span aria-hidden="true" />
        <button type="button" onClick={() => actions.current.centerView()} aria-label="Center view" title="Center view">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="4" />
            <path d="M10 2v3M10 15v3M2 10h3M15 10h3" />
          </svg>
        </button>
      </div>
    </>
  );
});
