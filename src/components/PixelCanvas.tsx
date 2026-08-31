import type { ReactNode } from "react";
import { carriesFiles, findImageFile } from "../pixels.ts";
import type { MovingSelection, Tool } from "../pixels.ts";
import { useEditorRuntime } from "../editor/EditorProvider.tsx";
import { usePointerInteractions } from "../editor/usePointerInteractions.ts";

export function PixelCanvas({
  tool,
  isPanning,
  movingSelection,
  isDropTarget,
  panelOpen,
  onReadFile,
  children,
}: {
  tool: Tool;
  isPanning: boolean;
  movingSelection: MovingSelection | null;
  isDropTarget: boolean;
  panelOpen: boolean;
  onReadFile: (file: File) => void;
  children?: ReactNode;
}) {
  const { canvasRef, pointerRef, rightDragEndedAtRef, contextMenuOpenedAtRef, setActivity, setIsDropTarget } =
    useEditorRuntime();
  const { handlePointerDown, handlePointerMove, handlePointerEnd, handleCanvasKeyDown, openCanvasMenuAt } =
    usePointerInteractions();

  return (
    <div
      className={`canvas-column${panelOpen ? " canvas-column--exporting" : ""}${isDropTarget ? " canvas-column--dropping" : ""}`}
      onDragOver={(event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setIsDropTarget(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDropTarget(false);
      }}
      onDrop={(event) => {
        const file = findImageFile(event.dataTransfer.files, event.dataTransfer.items);
        event.preventDefault();
        setIsDropTarget(false);
        if (file) onReadFile(file);
        else setActivity("Only image files can be dropped onto the canvas.");
      }}
    >
      <canvas
        ref={canvasRef}
        className={`pixel-canvas pixel-canvas--${tool}${isPanning ? " pixel-canvas--panning" : ""}${movingSelection ? " pixel-canvas--moving" : ""}`}
        aria-label="Pixel canvas, 1024 by 1024 cells. Use Draw, Erase, Fill, Line, Rectangle, Ellipse, Pick color, or Select; right-drag, Space-drag, or scroll to pan, and pinch or Control-scroll to zoom."
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={(event) => handlePointerEnd(event, true)}
        onLostPointerCapture={(event) => {
          const activePointer = pointerRef.current;
          if (activePointer && "pointerId" in activePointer && activePointer.pointerId === event.pointerId) {
            handlePointerEnd(event, true);
          }
        }}
        onKeyDown={handleCanvasKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          const activePointer = pointerRef.current;
          if (activePointer?.kind === "pan" && activePointer.button === 2) return;
          const now = performance.now();
          if (now - rightDragEndedAtRef.current < 400 || now - contextMenuOpenedAtRef.current < 250) return;
          openCanvasMenuAt(event.clientX, event.clientY);
        }}
      />
      {children}
    </div>
  );
}
