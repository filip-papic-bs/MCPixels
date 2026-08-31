import { memo } from "react";
import { MAX_IMPORT_DIMENSION } from "../pixels.ts";
import type { ImportSource, ScreenPoint, SelectionBounds, ViewSize } from "../pixels.ts";
import { useEditorRuntime } from "../editor/EditorProvider.tsx";

export const ImportPanel = memo(function ImportPanel({
  importSource,
  importDimensions,
  lockImportRatio,
  importError,
  isReadingImport,
  importDetectedSize,
  importFoundGrid,
  importFittedSize,
  importSizeError,
  importOrigin,
  selection,
  onClose,
  onWidthChange,
  onHeightChange,
  onRatioLockChange,
  onPlace,
}: {
  importSource: ImportSource | null;
  importDimensions: ViewSize;
  lockImportRatio: boolean;
  importError: string;
  isReadingImport: boolean;
  importDetectedSize: ViewSize | null;
  importFoundGrid: boolean;
  importFittedSize: ViewSize | null;
  importSizeError: string;
  importOrigin: ScreenPoint;
  selection: SelectionBounds | null;
  onClose: () => void;
  onWidthChange: (value: number) => void;
  onHeightChange: (value: number) => void;
  onRatioLockChange: (locked: boolean) => void;
  onPlace: () => void;
}) {
  const { setImportDimensions } = useEditorRuntime();

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
        aria-labelledby="import-title"
        tabIndex={-1}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header>
          <div>
            <span>Image import</span>
            <h2 id="import-title">Place image</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Cancel import">
            ×
          </button>
        </header>

        {importSource && importDetectedSize && importFittedSize ? (
          <>
            <p className="import-note">
              <strong>{importSource.name}</strong>
              <span>
                {importSource.width} × {importSource.height}px source ·{" "}
                {importFoundGrid
                  ? `pixel grid detected at ${importDetectedSize.width} × ${importDetectedSize.height}, about ${importSource.pitch.toFixed(1)}px per art pixel`
                  : "no pixel grid detected, importing one canvas pixel per image pixel"}
              </span>
            </p>

            <div className="export-dimensions">
              <label>
                <span>Width</span>
                <input
                  type="number"
                  min="1"
                  max={MAX_IMPORT_DIMENSION}
                  step="1"
                  value={importDimensions.width}
                  onChange={(event) => onWidthChange(event.target.valueAsNumber)}
                />
              </label>
              <span aria-hidden="true">×</span>
              <label>
                <span>Height</span>
                <input
                  type="number"
                  min="1"
                  max={MAX_IMPORT_DIMENSION}
                  step="1"
                  value={importDimensions.height}
                  onChange={(event) => onHeightChange(event.target.valueAsNumber)}
                />
              </label>
              <label className="export-ratio-lock">
                <input
                  type="checkbox"
                  checked={lockImportRatio}
                  onChange={(event) => onRatioLockChange(event.target.checked)}
                />
                Lock ratio
              </label>
            </div>

            {importDimensions.width !== importFittedSize.width ||
            importDimensions.height !== importFittedSize.height ? (
              <button className="import-reset" type="button" onClick={() => setImportDimensions(importFittedSize)}>
                Reset to {importFittedSize.width} × {importFittedSize.height}
              </button>
            ) : null}

            <div className="export-summary">
              <span>
                {selection ? "Top-left of the selection" : "Centered on the view"} at ({importOrigin.x},{" "}
                {importOrigin.y})
              </span>
              <strong>
                {importDimensions.width} × {importDimensions.height}px
              </strong>
            </div>
          </>
        ) : (
          <p className="import-note">
            <span>{isReadingImport ? "Reading the image…" : "No image loaded."}</span>
          </p>
        )}

        {importSizeError || importError ? <p className="export-error">{importSizeError || importError}</p> : null}

        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="export-download"
            type="button"
            disabled={!importSource || Boolean(importSizeError) || isReadingImport}
            onClick={onPlace}
          >
            Place pixels
          </button>
        </footer>
      </section>
    </div>
  );
});
