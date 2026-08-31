import { useEffect, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { isColorTool, supportsSymmetry, stepBrushSize, regionToScreen } from "./pixels";
import { HOLD_TO_OPEN } from "./editor/constants.tsx";
import { EditorProvider, useEditorRuntime, useEditorState } from "./editor/EditorProvider.tsx";
import { useCanvasKeyboard } from "./editor/useCanvasKeyboard.ts";
import { useExportPanel } from "./editor/useExportPanel.ts";
import { useImportPanel } from "./editor/useImportPanel.ts";
import { usePalette } from "./editor/usePalette.ts";
import { useSelectionOps } from "./editor/useSelectionOps.ts";
import { useViewportControls } from "./editor/useViewportControls.ts";
import { useWebMcpTools } from "./agent/useWebMcpTools.ts";
import { useAutoFollow } from "./editor/useAutoFollow.ts";
import { EditFlash } from "./components/EditFlash.tsx";
import { AgentHelpDialog } from "./components/AgentHelpDialog.tsx";
import { BottomDock } from "./components/BottomDock.tsx";
import { ExportPanel } from "./components/ExportPanel.tsx";
import { ImportPanel } from "./components/ImportPanel.tsx";
import { Masthead } from "./components/Masthead.tsx";
import { PixelCanvas } from "./components/PixelCanvas.tsx";
import { UtilityDocks } from "./components/UtilityDocks.tsx";
import { paintCanvas } from "./render/painter.ts";
import type { Tool } from "./pixels";

function Editor() {
  const runtime = useEditorRuntime();
  const {
    history,
    selectedColor,
    tool,
    shapeStyle,
    brushSize,
    symmetry,
    shapePreview,
    touchPreview,
    viewport,
    canvasSize,
    fitZoom,
    webMcpStatus,
    toolCount,
    isPanning,
    selection,
    movingSelection,
    copiedSelection,
    showExport,
    exportMode,
    exportScale,
    exportDimensions,
    lockExportRatio,
    exportError,
    isExporting,
    showImport,
    importSource,
    importDimensions,
    lockImportRatio,
    importError,
    isReadingImport,
    isDropTarget,
    storageError,
    dockPanel,
    canvasMenu,
    selectionActionsSize,
    autoFollow,
    activity,
    notices,
  } = useEditorState();
  const {
    store,
    cells,
    dispatch,
    canvasRef,
    canvasMenuRef,
    selectionActionsRef,
    importInputRef,
    paintCachesRef,
    toolBeforePickerRef,
    holdTimerRef,
    heldOpenRef,
    setTool,
    setBrushSize,
    setSymmetry,
    setSelection,
    setDockPanel,
    setCanvasMenu,
    setSelectionActionsSize,
    setActivity,
  } = runtime;

  useEffect(() => {
    if (!canvasMenu) return;
    const frame = window.requestAnimationFrame(() => {
      const menu = canvasMenuRef.current;
      if (menu) {
        const menuBounds = menu.getBoundingClientRect();
        const maxLeft = Math.max(8, canvasSize.width - menuBounds.width - 8);
        const maxTop = Math.max(8, canvasSize.height - menuBounds.height - 68);
        if (canvasMenu.x > maxLeft || canvasMenu.y > maxTop) {
          setCanvasMenu({ x: Math.min(canvasMenu.x, maxLeft), y: Math.min(canvasMenu.y, maxTop) });
          return;
        }
      }
      menu?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canvasMenu, canvasSize]);

  useEffect(() => {
    const actions = selectionActionsRef.current;
    if (!actions) return;
    const updateSize = () => {
      const bounds = actions.getBoundingClientRect();
      setSelectionActionsSize((current) =>
        current.width === bounds.width && current.height === bounds.height
          ? current
          : { width: bounds.width, height: bounds.height },
      );
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(actions);
    return () => observer.disconnect();
  }, [copiedSelection, dockPanel, selection]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    paintCanvas(
      canvas,
      {
        cells,
        viewport,
        view: canvasSize,
        fitZoom,
        selection,
        movingSelection,
        shapePreview,
        touchPreview,
        tool,
        symmetry,
      },
      paintCachesRef.current,
    );
  }, [
    canvasSize,
    cells,
    fitZoom,
    history.version,
    movingSelection,
    selection,
    shapePreview,
    symmetry,
    tool,
    touchPreview,
    viewport,
  ]);

  const { paletteColors, selectEditorColor } = usePalette();
  const { zoomBy, centerView, frameRegion: frameRegionOnScreen } = useViewportControls();
  const {
    clearSelection,
    copySelection,
    cutSelection,
    pasteSelection,
    moveSelectionBy,
    flipSelectionHorizontal,
    flipSelectionVertical,
    rotateSelectionClockwise,
    selectWholeCanvas,
    dismissSelection,
  } = useSelectionOps();

  const { flash, clearFlash } = useAutoFollow();
  useWebMcpTools();

  const [showAgentHelp, setShowAgentHelp] = useState(false);
  const {
    maxExportScale,
    exportOutputSize,
    exportSizeError,
    exportingFullCanvas,
    openExportPanel,
    exportFullCanvas,
    closeExportPanel,
    updateExportWidth,
    updateExportHeight,
    updateExportRatioLock,
    exportSelectionAsPng,
  } = useExportPanel();

  const {
    importDetectedSize,
    importFoundGrid,
    importFittedSize,
    importSizeError,
    importOrigin,
    readImportFile,
    updateImportWidth,
    updateImportHeight,
    updateImportRatioLock,
    closeImportPanel,
    placeImportedImage,
  } = useImportPanel();

  const clearCanvas = () => {
    dispatch({ type: "clear" });
    setDockPanel(null);
    setCanvasMenu(null);
    setActivity("You cleared the canvas.");
  };
  const selectTool = (next: Tool) => {
    if (next === "picker" && tool !== "picker") toolBeforePickerRef.current = isColorTool(tool) ? tool : "paint";
    setTool(next);
    setDockPanel(null);
    setCanvasMenu(null);
  };
  const togglePicker = () => selectTool("picker");
  const toggleSymmetry = (axis: "horizontal" | "vertical") => {
    setSymmetry((current) => ({ ...current, [axis]: !current[axis] }));
    setDockPanel(null);
  };
  const openImportPicker = () => {
    setDockPanel(null);
    setCanvasMenu(null);
    importInputRef.current?.click();
  };
  const symmetryEnabled = supportsSymmetry(tool);

  const selectionScreen = selection ? regionToScreen(selection, viewport, canvasSize) : null;
  const selectionSize = selection
    ? { width: selection.maxX - selection.minX + 1, height: selection.maxY - selection.minY + 1 }
    : null;
  const selectionActionsStyle = selectionScreen
    ? (() => {
        const gap = 8;
        const width = selectionActionsSize.width || 360;
        const height = selectionActionsSize.height || 44;
        const bottomLimit = Math.max(gap, canvasSize.height - height - 80);
        const aboveSpace = selectionScreen.top - gap;
        const belowSpace = canvasSize.height - 80 - selectionScreen.top - selectionScreen.height - gap;
        const requestedTop =
          aboveSpace >= height || aboveSpace >= belowSpace
            ? selectionScreen.top - height - gap
            : selectionScreen.top + selectionScreen.height + gap;
        const left = Math.max(
          gap,
          Math.min(canvasSize.width - width - gap, selectionScreen.left + selectionScreen.width / 2 - width / 2),
        );
        const top = Math.max(gap, Math.min(bottomLimit, requestedTop));
        return {
          "--selection-float-left": `${left}px`,
          "--selection-float-top": `${top}px`,
        } as CSSProperties;
      })()
    : undefined;

  const cancelHold = () => {
    if (holdTimerRef.current === null) return;
    window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  };

  const openBrushSizes = () => {
    cancelHold();
    heldOpenRef.current = true;
    setCanvasMenu(null);
    setDockPanel("size");
  };

  const brushSizeGestures = {
    onPointerDown: () => {
      cancelHold();
      heldOpenRef.current = false;
      holdTimerRef.current = window.setTimeout(openBrushSizes, HOLD_TO_OPEN);
    },
    onPointerUp: cancelHold,
    onPointerLeave: cancelHold,
    onPointerCancel: cancelHold,
    onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      openBrushSizes();
    },
  };

  const selectBrushTool = (next: Tool) => {
    setTool(next);
    if (heldOpenRef.current) {
      heldOpenRef.current = false;
      return;
    }
    setDockPanel(null);
  };

  const adjustBrushSize = (direction: number) => {
    const size = stepBrushSize(brushSize, direction);
    if (size === brushSize) return;
    setBrushSize(size);
    setActivity(`Brush size ${size}.`);
  };

  const chooseBrushSize = (size: number) => {
    setBrushSize(size);
    setDockPanel(null);
    setActivity(`Brush size ${size}.`);
  };

  const undoPixels = () => {
    if (history.undoDepth === 0) return;
    const patch = store.undoStack.at(-1);
    dispatch({ type: "undo" });
    if (patch?.selectionBefore) setSelection(patch.selectionBefore);
    setActivity("Undid the last pixel edit.");
  };

  const redoPixels = () => {
    if (history.redoDepth === 0) return;
    const patch = store.redoStack.at(-1);
    dispatch({ type: "redo" });
    if (patch?.selectionAfter) setSelection(patch.selectionAfter);
    setActivity("Redid the last pixel edit.");
  };

  runtime.actions.current = {
    undo: undoPixels,
    redo: redoPixels,
    clearCanvas,
    selectTool,
    selectEditorColor,
    togglePicker,
    chooseBrushSize,
    adjustBrushSize,
    selectBrushTool,
    openBrushSizes,
    toggleSymmetry,
    centerView,
    frameRegion: frameRegionOnScreen,
    selectWholeCanvas,
    dismissSelection,
    clearSelection,
    copySelection,
    cutSelection,
    pasteSelection,
    moveSelectionBy,
    flipSelectionHorizontal,
    flipSelectionVertical,
    rotateSelectionClockwise,
    openExportPanel,
    exportFullCanvas,
    openImportPicker,
  };
  useCanvasKeyboard();

  return (
    <main className="app-shell">
      <Masthead
        storageError={storageError}
        webMcpStatus={webMcpStatus}
        toolCount={toolCount}
        notices={notices}
        onExplainAgents={() => setShowAgentHelp(true)}
        onJumpTo={frameRegionOnScreen}
      />

      <section className="editor" aria-label="MCPixels editor">
        <BottomDock
          dockPanel={dockPanel}
          tool={tool}
          shapeStyle={shapeStyle}
          brushSize={brushSize}
          symmetry={symmetry}
          symmetryEnabled={symmetryEnabled}
          selectedColor={selectedColor}
          paletteColors={paletteColors}
          autoFollow={autoFollow}
          brushSizeGestures={brushSizeGestures}
        />

        <UtilityDocks
          hasSelection={selection !== null}
          canUndo={history.undoDepth > 0}
          canRedo={history.redoDepth > 0}
          onZoomIn={() => zoomBy(1.2)}
          onZoomOut={() => zoomBy(1 / 1.2)}
        />

        <input
          ref={importInputRef}
          hidden
          type="file"
          accept="image/*"
          aria-label="Import an image onto the canvas"
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null;
            event.target.value = "";
            setDockPanel(null);
            void readImportFile(file);
          }}
        />

        <PixelCanvas
          tool={tool}
          isPanning={isPanning}
          movingSelection={movingSelection}
          isDropTarget={isDropTarget}
          panelOpen={showExport || showImport}
          onReadFile={(file) => void readImportFile(file)}
        >
          <EditFlash flash={flash} viewport={viewport} view={canvasSize} onDone={clearFlash} />
          {selectionScreen ? (
            <>
              <div
                className="selection-outline"
                style={{
                  left: selectionScreen.left,
                  top: selectionScreen.top,
                  width: selectionScreen.width,
                  height: selectionScreen.height,
                }}
                aria-hidden="true"
              />
              {movingSelection || dockPanel ? null : (
                <div
                  ref={selectionActionsRef}
                  className={`selection-actions${copiedSelection ? " selection-actions--with-paste" : ""}`}
                  style={selectionActionsStyle}
                  role="toolbar"
                  aria-label="Selection actions"
                >
                  <button
                    type="button"
                    onClick={clearSelection}
                    aria-label="Clear selected pixels"
                    title="Clear selected pixels"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3.5 4.5h9M6 4.5v-2h4v2m1.5 0-.6 9h-5.8l-.6-9M7 7v4M9 7v4" />
                    </svg>
                  </button>
                  <span className="selection-action-separator" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={copySelection}
                    aria-label="Copy selected pixels"
                    aria-keyshortcuts="Control+C Meta+C"
                    title="Copy selected pixels (Ctrl/Cmd+C)"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <rect x="5.5" y="5.5" width="7" height="7" />
                      <path d="M3.5 10.5h-1v-8h8v1" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={cutSelection}
                    aria-label="Cut selected pixels"
                    aria-keyshortcuts="Control+X Meta+X"
                    title="Cut selected pixels (Ctrl/Cmd+X)"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="4" cy="4" r="2" />
                      <circle cx="4" cy="12" r="2" />
                      <path d="m5.5 5.5 7 7M5.5 10.5l7-7" />
                    </svg>
                  </button>
                  {copiedSelection ? (
                    <button
                      type="button"
                      onClick={pasteSelection}
                      aria-label="Paste copied pixels"
                      aria-keyshortcuts="Control+V Meta+V"
                      title="Paste copied pixels (Ctrl/Cmd+V)"
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M5 4V2.5h6V4m-7 0h8v9H4zM8 6v5m-2-2 2 2 2-2" />
                      </svg>
                    </button>
                  ) : null}
                  <span className="selection-action-separator" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={flipSelectionHorizontal}
                    aria-label="Flip selection horizontally"
                    title="Flip selection horizontally"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 2v12" />
                      <path d="M4 5 2 8l2 3M12 5l2 3-2 3" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={flipSelectionVertical}
                    aria-label="Flip selection vertically"
                    title="Flip selection vertically"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M2 8h12" />
                      <path d="M5 4 8 2l3 2M5 12l3 2 3-2" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={rotateSelectionClockwise}
                    aria-label="Rotate selection 90 degrees"
                    title="Rotate selection 90°"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <polyline points="15 3 15 7 11 7" />
                      <path d="M13.5 10a6 6 0 1 1-1.5-6L15 7" />
                    </svg>
                  </button>
                  <span className="selection-action-separator" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={() => openExportPanel()}
                    aria-label="Export selection"
                    title="Export selection"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 2v8m-3-3 3 3 3-3M3 11v2.5h10V11" />
                    </svg>
                  </button>
                  <span className="selection-action-separator" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={dismissSelection}
                    aria-label="Dismiss selection"
                    title="Dismiss selection"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="m4 4 8 8m0-8-8 8" />
                    </svg>
                  </button>
                </div>
              )}
            </>
          ) : null}
          {canvasMenu ? (
            <div
              ref={canvasMenuRef}
              className="canvas-context-menu"
              style={{ left: canvasMenu.x, top: canvasMenu.y }}
              role="menu"
              aria-label="Canvas menu"
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
                );
                const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setCanvasMenu(null);
                  canvasRef.current?.focus();
                  return;
                }
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
                const nextIndex =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : event.key === "ArrowDown"
                        ? (currentIndex + 1) % buttons.length
                        : (currentIndex - 1 + buttons.length) % buttons.length;
                buttons[nextIndex]?.focus();
              }}
            >
              <button
                type="button"
                role="menuitem"
                disabled={!copiedSelection}
                onClick={() => {
                  pasteSelection();
                  setCanvasMenu(null);
                }}
              >
                Paste here
              </button>
              {selection ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    copySelection();
                    setCanvasMenu(null);
                  }}
                >
                  Copy selection
                </button>
              ) : null}
              {selection ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    clearSelection();
                    setCanvasMenu(null);
                  }}
                >
                  Delete selection
                </button>
              ) : null}
              <span aria-hidden="true" />
              <button
                type="button"
                role="menuitem"
                disabled={history.undoDepth === 0}
                onClick={() => {
                  undoPixels();
                  setCanvasMenu(null);
                }}
              >
                Undo
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={history.redoDepth === 0}
                onClick={() => {
                  redoPixels();
                  setCanvasMenu(null);
                }}
              >
                Redo
              </button>
              <span aria-hidden="true" />
              <button type="button" role="menuitem" onClick={openImportPicker}>
                Import image
              </button>
              {selection ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCanvasMenu(null);
                    openExportPanel();
                  }}
                >
                  Export selection
                </button>
              ) : null}
              <button type="button" role="menuitem" onClick={exportFullCanvas}>
                Export canvas
              </button>
              <button type="button" role="menuitem" onClick={centerView}>
                Center view
              </button>
              <span aria-hidden="true" />
              <button className="danger-option" type="button" role="menuitem" onClick={clearCanvas}>
                Clear canvas
              </button>
            </div>
          ) : null}
          {showExport && selectionSize ? (
            <ExportPanel
              selectionSize={selectionSize}
              exportMode={exportMode}
              exportScale={exportScale}
              exportDimensions={exportDimensions}
              lockExportRatio={lockExportRatio}
              exportError={exportError}
              isExporting={isExporting}
              maxExportScale={maxExportScale}
              exportOutputSize={exportOutputSize}
              exportSizeError={exportSizeError}
              exportingFullCanvas={exportingFullCanvas}
              onClose={closeExportPanel}
              onWidthChange={updateExportWidth}
              onHeightChange={updateExportHeight}
              onRatioLockChange={updateExportRatioLock}
              onDownload={() => void exportSelectionAsPng()}
            />
          ) : null}
          {showImport ? (
            <ImportPanel
              importSource={importSource}
              importDimensions={importDimensions}
              lockImportRatio={lockImportRatio}
              importError={importError}
              isReadingImport={isReadingImport}
              importDetectedSize={importDetectedSize}
              importFoundGrid={importFoundGrid}
              importFittedSize={importFittedSize}
              importSizeError={importSizeError}
              importOrigin={importOrigin}
              selection={selection}
              onClose={closeImportPanel}
              onWidthChange={updateImportWidth}
              onHeightChange={updateImportHeight}
              onRatioLockChange={updateImportRatioLock}
              onPlace={placeImportedImage}
            />
          ) : null}
          <footer className="canvas-meta">
            <span>
              {Math.round(viewport.x)}, {Math.round(viewport.y)}
            </span>
            <span className="sr-only" aria-live="polite">
              {storageError || activity}
            </span>
          </footer>
        </PixelCanvas>
      </section>

      {showAgentHelp ? <AgentHelpDialog onClose={() => setShowAgentHelp(false)} /> : null}
    </main>
  );
}

export default function App() {
  return (
    <EditorProvider>
      <Editor />
    </EditorProvider>
  );
}
