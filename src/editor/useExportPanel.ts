import { CANVAS_MAX, CANVAS_MIN, DEFAULT_EXPORT_SCALE, MAX_EXPORT_DIMENSION, MAX_EXPORT_SCALE } from "../pixels.ts";
import type { SelectionBounds } from "../pixels.ts";
import { downloadBlob, renderScaledPng } from "../render/raster.ts";
import { useEditorRuntime, useEditorState } from "./EditorProvider.tsx";

export function useExportPanel() {
  const { selection, exportMode, exportScale, exportDimensions, lockExportRatio } = useEditorState();
  const runtime = useEditorRuntime();
  const {
    store,
    selectionBeforeExportRef,
    exportReplacedSelectionRef,
    setActivity,
    setCanvasMenu,
    setDockPanel,
    setExportDimensions,
    setExportError,
    setExportMode,
    setExportScale,
    setIsExporting,
    setLockExportRatio,
    setSelection,
    setShowExport,
  } = runtime;

  const selectionSize = selection
    ? { width: selection.maxX - selection.minX + 1, height: selection.maxY - selection.minY + 1 }
    : null;

  const maxExportScale = selectionSize
    ? Math.max(
        1,
        Math.min(
          MAX_EXPORT_SCALE,
          Math.floor(MAX_EXPORT_DIMENSION / selectionSize.width),
          Math.floor(MAX_EXPORT_DIMENSION / selectionSize.height),
        ),
      )
    : MAX_EXPORT_SCALE;

  const exportOutputSize = selectionSize
    ? exportMode === "scale"
      ? { width: selectionSize.width * exportScale, height: selectionSize.height * exportScale }
      : exportDimensions
    : { width: 1, height: 1 };

  const exportSizeError = !selectionSize
    ? "No selection to export."
    : selectionSize.width > MAX_EXPORT_DIMENSION || selectionSize.height > MAX_EXPORT_DIMENSION
      ? `Selections must be at most ${MAX_EXPORT_DIMENSION}px per side to export.`
      : exportOutputSize.width > MAX_EXPORT_DIMENSION || exportOutputSize.height > MAX_EXPORT_DIMENSION
        ? `Output must be at most ${MAX_EXPORT_DIMENSION}px per side.`
        : "";

  const exportingFullCanvas = Boolean(
    selection &&
      selection.minX <= CANVAS_MIN &&
      selection.minY <= CANVAS_MIN &&
      selection.maxX >= CANVAS_MAX &&
      selection.maxY >= CANVAS_MAX,
  );

  const openExportPanel = (bounds?: SelectionBounds) => {
    const area = bounds ?? selection;
    if (!area) return;
    const width = area.maxX - area.minX + 1;
    const height = area.maxY - area.minY + 1;
    const scale = Math.max(
      1,
      Math.min(
        DEFAULT_EXPORT_SCALE,
        MAX_EXPORT_SCALE,
        Math.floor(MAX_EXPORT_DIMENSION / width),
        Math.floor(MAX_EXPORT_DIMENSION / height),
      ),
    );
    if (bounds) {
      selectionBeforeExportRef.current = selection;
      exportReplacedSelectionRef.current = true;
      setSelection(bounds);
    } else {
      exportReplacedSelectionRef.current = false;
    }
    setExportMode("scale");
    setExportScale(scale);
    setExportDimensions({ width: width * scale, height: height * scale });
    setLockExportRatio(true);
    setExportError("");
    setShowExport(true);
  };

  const exportFullCanvas = () => {
    setDockPanel(null);
    setCanvasMenu(null);
    openExportPanel({ minX: CANVAS_MIN, minY: CANVAS_MIN, maxX: CANVAS_MAX, maxY: CANVAS_MAX });
  };

  const restoreSelectionAfterExport = () => {
    if (!exportReplacedSelectionRef.current) return;
    exportReplacedSelectionRef.current = false;
    setSelection(selectionBeforeExportRef.current);
    selectionBeforeExportRef.current = null;
  };

  const closeExportPanel = () => {
    setShowExport(false);
    setExportError("");
    restoreSelectionAfterExport();
    setActivity("Export cancelled.");
  };

  const updateExportWidth = (value: number) => {
    if (!selectionSize) return;
    let width = Math.min(MAX_EXPORT_DIMENSION, Math.max(1, Math.round(value) || 1));
    let height = lockExportRatio
      ? Math.max(1, Math.round(width * (selectionSize.height / selectionSize.width)))
      : exportDimensions.height;
    if (height > MAX_EXPORT_DIMENSION) {
      height = MAX_EXPORT_DIMENSION;
      width = Math.max(1, Math.round(height * (selectionSize.width / selectionSize.height)));
    }
    setExportDimensions({ width, height });
    setExportError("");
  };

  const updateExportHeight = (value: number) => {
    if (!selectionSize) return;
    let height = Math.min(MAX_EXPORT_DIMENSION, Math.max(1, Math.round(value) || 1));
    let width = lockExportRatio
      ? Math.max(1, Math.round(height * (selectionSize.width / selectionSize.height)))
      : exportDimensions.width;
    if (width > MAX_EXPORT_DIMENSION) {
      width = MAX_EXPORT_DIMENSION;
      height = Math.max(1, Math.round(width * (selectionSize.height / selectionSize.width)));
    }
    setExportDimensions({ width, height });
    setExportError("");
  };

  const updateExportRatioLock = (locked: boolean) => {
    setLockExportRatio(locked);
    if (!locked || !selectionSize) return;
    let width = exportDimensions.width;
    let height = Math.max(1, Math.round(width * (selectionSize.height / selectionSize.width)));
    if (height > MAX_EXPORT_DIMENSION) {
      height = MAX_EXPORT_DIMENSION;
      width = Math.max(1, Math.round(height * (selectionSize.width / selectionSize.height)));
    }
    setExportDimensions({ width, height });
  };

  const exportSelectionAsPng = async () => {
    if (!selection || !selectionSize || exportSizeError) return;
    setIsExporting(true);
    setExportError("");
    try {
      const blob = await renderScaledPng(store.cells, selection, exportOutputSize);
      downloadBlob(blob, `mcpixels-${exportOutputSize.width}x${exportOutputSize.height}.png`);
      setShowExport(false);
      restoreSelectionAfterExport();
      setActivity(`Exported a ${exportOutputSize.width} by ${exportOutputSize.height} PNG.`);
    } catch (error) {
      console.error("Could not export the MCPixels selection", error);
      setExportError(error instanceof Error ? error.message : "Could not export the selection");
    } finally {
      setIsExporting(false);
    }
  };

  return {
    selectionSize,
    maxExportScale,
    exportOutputSize,
    exportSizeError,
    exportingFullCanvas,
    openExportPanel,
    exportFullCanvas,
    restoreSelectionAfterExport,
    closeExportPanel,
    updateExportWidth,
    updateExportHeight,
    updateExportRatioLock,
    exportSelectionAsPng,
  };
}
