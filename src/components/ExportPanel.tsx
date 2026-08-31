import { memo } from "react";
import { MAX_EXPORT_DIMENSION } from "../pixels.ts";
import type { ExportMode, ViewSize } from "../pixels.ts";
import { useEditorRuntime } from "../editor/EditorProvider.tsx";

export const ExportPanel = memo(function ExportPanel({
  selectionSize,
  exportMode,
  exportScale,
  exportDimensions,
  lockExportRatio,
  exportError,
  isExporting,
  maxExportScale,
  exportOutputSize,
  exportSizeError,
  exportingFullCanvas,
  onClose,
  onWidthChange,
  onHeightChange,
  onRatioLockChange,
  onDownload,
}: {
  selectionSize: ViewSize;
  exportMode: ExportMode;
  exportScale: number;
  exportDimensions: ViewSize;
  lockExportRatio: boolean;
  exportError: string;
  isExporting: boolean;
  maxExportScale: number;
  exportOutputSize: ViewSize;
  exportSizeError: string;
  exportingFullCanvas: boolean;
  onClose: () => void;
  onWidthChange: (value: number) => void;
  onHeightChange: (value: number) => void;
  onRatioLockChange: (locked: boolean) => void;
  onDownload: () => void;
}) {
  const { setExportMode, setExportScale, setExportError } = useEditorRuntime();

  return (
    <div
      className="export-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="export-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        tabIndex={-1}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header>
          <div>
            <span>PNG export</span>
            <h2 id="export-title">{exportingFullCanvas ? "Export canvas" : "Export selection"}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Cancel export">
            ×
          </button>
        </header>

        <div className="export-mode" role="group" aria-label="Export sizing mode">
          {(["scale", "dimensions"] as ExportMode[]).map((mode) => (
            <button
              key={mode}
              className={exportMode === mode ? "export-mode--active" : ""}
              type="button"
              aria-pressed={exportMode === mode}
              onClick={() => {
                setExportMode(mode);
                setExportError("");
              }}
            >
              {mode === "scale" ? "Scale" : "Dimensions"}
            </button>
          ))}
        </div>

        {exportMode === "scale" ? (
          <label className="export-scale">
            <span>Multiplier</span>
            <div>
              <input
                type="number"
                min="1"
                max={maxExportScale}
                step="1"
                value={exportScale}
                onChange={(event) => {
                  setExportScale(Math.min(maxExportScale, Math.max(1, Math.round(event.target.valueAsNumber) || 1)));
                  setExportError("");
                }}
              />
              <span>×</span>
            </div>
          </label>
        ) : (
          <div className="export-dimensions">
            <label>
              <span>Width</span>
              <input
                type="number"
                min="1"
                max={MAX_EXPORT_DIMENSION}
                step="1"
                value={exportDimensions.width}
                onChange={(event) => onWidthChange(event.target.valueAsNumber)}
              />
            </label>
            <span aria-hidden="true">×</span>
            <label>
              <span>Height</span>
              <input
                type="number"
                min="1"
                max={MAX_EXPORT_DIMENSION}
                step="1"
                value={exportDimensions.height}
                onChange={(event) => onHeightChange(event.target.valueAsNumber)}
              />
            </label>
            <label className="export-ratio-lock">
              <input
                type="checkbox"
                checked={lockExportRatio}
                onChange={(event) => onRatioLockChange(event.target.checked)}
              />
              Lock ratio
            </label>
          </div>
        )}

        <div className="export-summary">
          <span>
            {exportingFullCanvas ? "Canvas" : "Selection"} {selectionSize.width} × {selectionSize.height}px
          </span>
          <strong>
            {exportOutputSize.width} × {exportOutputSize.height}px
          </strong>
        </div>
        {exportSizeError || exportError ? <p className="export-error">{exportSizeError || exportError}</p> : null}

        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="export-download"
            type="button"
            disabled={Boolean(exportSizeError) || isExporting}
            onClick={onDownload}
          >
            {isExporting ? "Exporting..." : "Download PNG"}
          </button>
        </footer>
      </section>
    </div>
  );
});
