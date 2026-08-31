import {
  CANVAS_MAX,
  CANVAS_MIN,
  CANVAS_SIZE,
  boundsForOrigin,
  captureRegion,
  clampOriginToCanvas,
  countPaintedCells,
  offsetSelection,
  placeRegion,
  transformRegion,
} from "../pixels.ts";
import type { CopiedSelection, RegionTransform, SelectionBounds } from "../pixels.ts";
import { canvasToPng, renderRegionCanvas } from "../render/raster.ts";
import { useEditorRuntime, useEditorState } from "./EditorProvider.tsx";

export function useSelectionOps() {
  const { selection, copiedSelection } = useEditorState();
  const {
    store,
    dispatch,
    clipboardPngRef,
    lastCanvasPointerRef,
    setActivity,
    setCanvasMenu,
    setCopiedSelection,
    setDockPanel,
    setSelection,
    setShowExport,
    setTool,
  } = useEditorRuntime();

  const captureSelection = () => (selection ? captureRegion(store.cells, selection) : null);

  const renderSelectionCanvas = (bounds: SelectionBounds) => renderRegionCanvas(store.cells, bounds);

  const copySelectionToClipboard = (bounds: SelectionBounds) => {
    if (typeof ClipboardItem !== "function" || typeof navigator.clipboard?.write !== "function") return null;
    const canvas = renderSelectionCanvas(bounds);
    if (!canvas) return null;
    const png = canvasToPng(canvas).then((blob) => {
      // Remembered so pasting this PNG back in restores pixels, not an import.
      clipboardPngRef.current = { width: canvas.width, height: canvas.height };
      return blob;
    });
    try {
      return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    } catch (error) {
      console.warn("This browser refused a PNG on the system clipboard", error);
      return null;
    }
  };

  const shareSelectionAsPng = (bounds: SelectionBounds, copied: CopiedSelection, verb: string) => {
    const written = copySelectionToClipboard(bounds);
    if (!written) return;
    written.then(
      () =>
        setActivity(
          `${verb} ${copied.pixels.length} pixel${copied.pixels.length === 1 ? "" : "s"} and a ${copied.width} by ${copied.height} PNG to the clipboard.`,
        ),
      (error: unknown) => console.warn("Could not put the selection on the system clipboard", error),
    );
  };

  const clearSelection = () => {
    if (!selection) return;
    const cleared = countPaintedCells(store.cells, selection);
    dispatch({ type: "clear-area", bounds: selection });
    setSelection(null);
    setActivity(`Cleared ${cleared} pixel${cleared === 1 ? "" : "s"} from the selection.`);
  };

  const copySelection = () => {
    if (!selection) return;
    const copied = captureSelection();
    if (!copied) return;
    setCopiedSelection(copied);
    setActivity(
      `Copied ${copied.pixels.length} pixel${copied.pixels.length === 1 ? "" : "s"} from a ${copied.width} by ${copied.height} selection.`,
    );
    shareSelectionAsPng(selection, copied, "Copied");
  };

  const cutSelection = () => {
    if (!selection) return;
    const copied = captureSelection();
    if (!copied) return;
    setCopiedSelection(copied);
    shareSelectionAsPng(selection, copied, "Cut");
    dispatch({ type: "clear-area", bounds: selection });
    setActivity(
      `Cut ${copied.pixels.length} pixel${copied.pixels.length === 1 ? "" : "s"} from a ${copied.width} by ${copied.height} selection.`,
    );
  };

  const pasteSelection = () => {
    if (!copiedSelection) return;
    const origin = clampOriginToCanvas(
      lastCanvasPointerRef.current ?? copiedSelection.origin,
      copiedSelection.width,
      copiedSelection.height,
    );
    const changes = placeRegion(copiedSelection, origin);
    if (changes.length > 0) dispatch({ type: "paint", changes });
    setSelection(boundsForOrigin(origin, copiedSelection.width, copiedSelection.height));
    setActivity(
      `Pasted ${changes.length} pixel${changes.length === 1 ? "" : "s"} from a ${copiedSelection.width} by ${copiedSelection.height} copy at (${origin.x}, ${origin.y}).`,
    );
  };

  const moveSelectionBy = (dx: number, dy: number) => {
    if (!selection) return;
    const nextSelection = offsetSelection(selection, dx, dy);
    if (!nextSelection) {
      setActivity("The selection is already at the canvas edge.");
      return;
    }
    const captured = captureSelection();
    if (!captured) return;
    const changes = placeRegion(captured, { x: nextSelection.minX, y: nextSelection.minY });
    if (changes.length > 0) {
      dispatch({
        type: "move",
        from: selection,
        changes,
        selectionBefore: selection,
        selectionAfter: nextSelection,
      });
    }
    setSelection(nextSelection);
    setActivity(
      `Moved the selection by ${dx !== 0 ? `${Math.abs(dx)} pixel ${dx < 0 ? "left" : "right"}` : `${Math.abs(dy)} pixel ${dy < 0 ? "up" : "down"}`}.`,
    );
  };

  const transformSelection = (kind: RegionTransform, label: string) => {
    if (!selection) return;
    const captured = captureSelection();
    if (!captured) return;
    const transformed = transformRegion(captured, kind);
    // A rotate swaps width and height, so a tall selection near the right edge
    // would otherwise spill off-canvas and silently lose pixels.
    const origin = clampOriginToCanvas({ x: selection.minX, y: selection.minY }, transformed.width, transformed.height);
    const changes = placeRegion(transformed, origin);
    const nextSelection = boundsForOrigin(origin, transformed.width, transformed.height);
    dispatch({
      type: "move",
      from: selection,
      changes,
      selectionBefore: selection,
      selectionAfter: nextSelection,
    });
    setSelection(nextSelection);
    setActivity(`${label} the selection.`);
  };

  const selectWholeCanvas = () => {
    setSelection({ minX: CANVAS_MIN, minY: CANVAS_MIN, maxX: CANVAS_MAX, maxY: CANVAS_MAX });
    setTool("select");
    setCanvasMenu(null);
    setDockPanel(null);
    setActivity(`Selected the whole ${CANVAS_SIZE} by ${CANVAS_SIZE} canvas.`);
  };

  const dismissSelection = () => {
    setShowExport(false);
    setSelection(null);
    setActivity("Selection dismissed.");
  };

  return {
    captureSelection,
    renderSelectionCanvas,
    clearSelection,
    copySelection,
    cutSelection,
    pasteSelection,
    moveSelectionBy,
    flipSelectionHorizontal: () => transformSelection("flip-left-right", "Flipped horizontally"),
    flipSelectionVertical: () => transformSelection("flip-top-bottom", "Flipped vertically"),
    rotateSelectionClockwise: () => transformSelection("rotate", "Rotated"),
    selectWholeCanvas,
    dismissSelection,
  };
}
