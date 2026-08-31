import { useEffect } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  DEFAULT_ZOOM,
  DRAG_THRESHOLD,
  EMPTY_CELL,
  EMPTY_PIXEL,
  MAX_SHAPE_PIXELS,
  applySymmetry,
  brushStamp,
  cellFromColor,
  cellIndex,
  clampSelectionToCanvas,
  clampViewport,
  clampZoom,
  colorFromCell,
  fitZoomFor,
  floodFill,
  getPinchMetrics,
  isOnCanvas,
  isShapeTool,
  pixelsInShape,
  pixelsOnLine,
  selectionBounds,
} from "../pixels.ts";
import type { FillResult, PixelChange, PointerState, SelectionBounds, ShapeTool } from "../pixels.ts";
import { useEditorRuntime, useEditorState } from "./EditorProvider.tsx";
import { usePalette } from "./usePalette.ts";
import { useSelectionOps } from "./useSelectionOps.ts";
import { useViewportControls } from "./useViewportControls.ts";

export function usePointerInteractions() {
  const {
    brushSize,
    canvasSize,
    fitZoom,
    movingSelection,
    selectedColor,
    selection,
    shapeStyle,
    symmetry,
    tool,
    viewport,
  } = useEditorState();
  const {
    store,
    dispatch,
    canvasRef,
    contextMenuOpenedAtRef,
    historyGroupRef,
    lastCanvasPointerRef,
    pointerRef,
    rightDragEndedAtRef,
    selectionBeforeTouchRef,
    shapePreviewFrameRef,
    spacePressedRef,
    toolBeforePickerRef,
    touchPointsRef,
    setActivity,
    setCanvasMenu,
    setDockPanel,
    setIsPanning,
    setMovingSelection,
    setSelection,
    setShapePreview,
    setTool,
    setTouchPreview,
    setViewport,
    interruptView,
  } = useEditorRuntime();
  const { selectEditorColor, keepUsedColor } = usePalette();
  const { zoomTo } = useViewportControls();
  const { captureSelection } = useSelectionOps();

  const getCanvasPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    return { x: clientX - bounds.left, y: clientY - bounds.top };
  };

  const getPixelAt = (clientX: number, clientY: number) => {
    const point = getCanvasPoint(clientX, clientY);
    if (!point) return null;
    return {
      x: Math.floor(viewport.x + (point.x - canvasSize.width / 2) / viewport.zoom),
      y: Math.floor(viewport.y + (point.y - canvasSize.height / 2) / viewport.zoom),
    };
  };

  const startDrawingAt = (clientX: number, clientY: number, pointerId: number, defer = false) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel) return;
    const color = tool === "erase" ? EMPTY_PIXEL : selectedColor;
    const changes = applySymmetry(brushStamp([pixel], brushSize, color), symmetry);
    if (!changes) return;
    historyGroupRef.current += 1;
    const historyGroup = historyGroupRef.current;
    pointerRef.current = {
      kind: "draw",
      pointerId,
      lastPixel: pixel,
      historyGroup,
      color,
      brush: brushSize,
      symmetry,
      pendingChanges: defer ? changes : undefined,
    };
    if (defer) {
      setTouchPreview(changes);
      return;
    }
    dispatch({
      type: "paint",
      changes,
      historyGroup,
    });
    keepUsedColor(color);
    setActivity(`You ${tool === "erase" ? "erased" : "painted"} pixel (${pixel.x}, ${pixel.y}).`);
  };

  const continueDrawingAt = (clientX: number, clientY: number, pointer: Extract<PointerState, { kind: "draw" }>) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel || (pixel.x === pointer.lastPixel.x && pixel.y === pointer.lastPixel.y)) return;
    const changes = applySymmetry(
      brushStamp(pixelsOnLine(pointer.lastPixel, pixel, pointer.color), pointer.brush, pointer.color),
      pointer.symmetry,
    );
    if (!changes) return;
    if (pointer.pendingChanges) {
      const pendingChanges = [...pointer.pendingChanges, ...changes];
      pointerRef.current = { ...pointer, lastPixel: pixel, pendingChanges };
      setTouchPreview(pendingChanges);
      return;
    }
    dispatch({
      type: "paint",
      changes,
      historyGroup: pointer.historyGroup,
    });
    pointerRef.current = { ...pointer, lastPixel: pixel };
    setActivity(`You ${pointer.color === EMPTY_PIXEL ? "erased to" : "painted to"} pixel (${pixel.x}, ${pixel.y}).`);
  };

  const startShapeAt = (clientX: number, clientY: number, pointerId: number, shapeTool: ShapeTool) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel) return;
    const pointer: Extract<PointerState, { kind: "shape" }> = {
      kind: "shape",
      pointerId,
      anchor: pixel,
      current: pixel,
      tool: shapeTool,
      color: selectedColor,
      style: shapeStyle,
      symmetry,
    };
    pointerRef.current = pointer;
    setShapePreview(pixelsInShape(shapeTool, pixel, pixel, shapeStyle, selectedColor, symmetry) ?? []);
  };

  const continueShapeAt = (clientX: number, clientY: number, pointer: Extract<PointerState, { kind: "shape" }>) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel || (pixel.x === pointer.current.x && pixel.y === pointer.current.y)) return;
    const nextPointer = { ...pointer, current: pixel };
    pointerRef.current = nextPointer;
    if (shapePreviewFrameRef.current !== null) return;
    shapePreviewFrameRef.current = window.requestAnimationFrame(() => {
      shapePreviewFrameRef.current = null;
      const activePointer = pointerRef.current;
      if (activePointer?.kind !== "shape") return;
      setShapePreview(
        pixelsInShape(
          activePointer.tool,
          activePointer.anchor,
          activePointer.current,
          activePointer.style,
          activePointer.color,
          activePointer.symmetry,
        ) ?? [],
      );
    });
  };

  const fillAt = (clientX: number, clientY: number) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel) return;
    const seeds = applySymmetry([{ ...pixel, color: selectedColor }], symmetry) ?? [];
    const workingCells = seeds.length > 1 ? store.cells.slice() : store.cells;
    const changes: PixelChange[] = [];
    let regions = 0;
    let reason: FillResult["reason"];
    for (const seed of seeds) {
      const result = floodFill(workingCells, seed, selectedColor);
      reason ??= result.reason;
      if (result.changes.length === 0) continue;
      regions += 1;
      changes.push(...result.changes);
      if (workingCells !== store.cells) {
        const replacement = cellFromColor(selectedColor);
        for (const change of result.changes) workingCells[cellIndex(change.x, change.y)] = replacement;
      }
    }
    if (changes.length > 0) {
      dispatch({ type: "paint", changes });
      keepUsedColor(selectedColor);
      setActivity(
        `Filled ${changes.length} pixel${changes.length === 1 ? "" : "s"}${regions > 1 ? ` across ${regions} mirrored regions` : ""}.`,
      );
      return;
    }
    if (reason === "off-canvas") setActivity("That point is outside the canvas.");
    else setActivity("That area already uses the selected color.");
  };

  const pickColorAt = (clientX: number, clientY: number) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel) return;
    if (!isOnCanvas(pixel.x, pixel.y)) return;
    const cell = store.cells[cellIndex(pixel.x, pixel.y)];
    if (cell === EMPTY_CELL) {
      setActivity("There is no color at that pixel to pick.");
      return;
    }
    const color = colorFromCell(cell);
    selectEditorColor(color);
    setTool(toolBeforePickerRef.current);
    setActivity(`Picked ${color} from pixel (${pixel.x}, ${pixel.y}).`);
  };

  const startSelectionAt = (clientX: number, clientY: number, pointerId: number) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel) return;
    pointerRef.current = { kind: "select", pointerId, anchor: pixel };
    setSelection(clampSelectionToCanvas(selectionBounds(pixel, pixel)));
  };

  const isInsideSelection = (pixel: { x: number; y: number }, bounds: SelectionBounds) =>
    pixel.x >= bounds.minX && pixel.x <= bounds.maxX && pixel.y >= bounds.minY && pixel.y <= bounds.maxY;

  const startMoveSelectionAt = (clientX: number, clientY: number, pointerId: number) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel || !selection) return;
    const captured = captureSelection();
    if (!captured) return;
    pointerRef.current = { kind: "move-selection", pointerId, anchor: pixel };
    setMovingSelection({ originalBounds: selection, captured });
  };

  const openCanvasMenuAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const pixel = getPixelAt(clientX, clientY);
    if (pixel && isOnCanvas(pixel.x, pixel.y)) lastCanvasPointerRef.current = pixel;
    setDockPanel(null);
    setCanvasMenu({
      x: Math.max(8, clientX - bounds.left),
      y: Math.max(8, clientY - bounds.top),
    });
    contextMenuOpenedAtRef.current = performance.now();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    interruptView.current();
    setCanvasMenu(null);
    setDockPanel(null);
    const pointerPixel = getPixelAt(event.clientX, event.clientY);
    if (pointerPixel && isOnCanvas(pointerPixel.x, pointerPixel.y)) lastCanvasPointerRef.current = pointerPixel;
    const isTouch = event.pointerType === "touch";
    if (isTouch) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const pinch = getPinchMetrics(touchPointsRef.current);
      if (pinch) {
        const activePointer = pointerRef.current;
        if (activePointer?.kind === "select") setSelection(selectionBeforeTouchRef.current);
        if (activePointer?.kind === "move-selection" && movingSelection) {
          setSelection(movingSelection.originalBounds);
        }
        selectionBeforeTouchRef.current = null;
        setShapePreview([]);
        setTouchPreview([]);
        setMovingSelection(null);
        pointerRef.current = {
          kind: "pinch",
          lastCenter: pinch.center,
          lastDistance: pinch.distance,
        };
        setIsPanning(true);
        return;
      }
    }
    if (pointerRef.current) return;
    const isContextClick = event.button === 2 || (event.pointerType === "mouse" && event.button === 0 && event.ctrlKey);
    const shouldPan =
      event.button === 1 || isContextClick || tool === "pan" || (event.button === 0 && spacePressedRef.current);
    const shouldFill = event.button === 0 && !shouldPan && tool === "fill";
    const shouldPickColor = event.button === 0 && !shouldPan && tool === "picker";
    const shouldSelect = event.button === 0 && !shouldPan && tool === "select";
    const shouldDraw = event.button === 0 && !shouldPan && (tool === "paint" || tool === "erase");
    const shouldShape = event.button === 0 && !shouldPan && isShapeTool(tool);
    if (!shouldPan && !shouldDraw && !shouldFill && !shouldPickColor && !shouldSelect && !shouldShape) return;

    event.preventDefault();
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);

    if (shouldSelect) {
      const pixel = getPixelAt(event.clientX, event.clientY);
      if (isTouch) selectionBeforeTouchRef.current = selection;
      if (pixel && selection && isInsideSelection(pixel, selection)) {
        startMoveSelectionAt(event.clientX, event.clientY, event.pointerId);
      } else {
        startSelectionAt(event.clientX, event.clientY, event.pointerId);
      }
      return;
    }
    if (shouldShape) {
      startShapeAt(event.clientX, event.clientY, event.pointerId, tool);
      return;
    }
    if (shouldFill) {
      if (isTouch) {
        pointerRef.current = {
          kind: "tap-tool",
          pointerId: event.pointerId,
          tool: "fill",
          clientX: event.clientX,
          clientY: event.clientY,
        };
        return;
      }
      fillAt(event.clientX, event.clientY);
      return;
    }
    if (shouldPickColor) {
      if (isTouch) {
        pointerRef.current = {
          kind: "tap-tool",
          pointerId: event.pointerId,
          tool: "picker",
          clientX: event.clientX,
          clientY: event.clientY,
        };
        return;
      }
      pickColorAt(event.clientX, event.clientY);
      return;
    }
    if (shouldDraw) {
      startDrawingAt(event.clientX, event.clientY, event.pointerId, isTouch);
      return;
    }

    pointerRef.current = {
      kind: "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      hasDragged: false,
      button: isContextClick ? 2 : event.button,
    };
    setIsPanning(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pointerPixel = getPixelAt(event.clientX, event.clientY);
    if (pointerPixel && isOnCanvas(pointerPixel.x, pointerPixel.y)) lastCanvasPointerRef.current = pointerPixel;
    if (touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    const pointer = pointerRef.current;
    if (!pointer || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if ("pointerId" in pointer && pointer.pointerId !== event.pointerId) return;

    if (pointer.kind === "pinch") {
      const pinch = getPinchMetrics(touchPointsRef.current);
      if (!pinch) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const previousAnchor = {
        x: pointer.lastCenter.x - bounds.left,
        y: pointer.lastCenter.y - bounds.top,
      };
      const nextAnchor = {
        x: pinch.center.x - bounds.left,
        y: pinch.center.y - bounds.top,
      };
      setViewport((current) => {
        const zoom = clampZoom(current.zoom * (pinch.distance / pointer.lastDistance), fitZoom);
        const worldX = current.x + (previousAnchor.x - canvasSize.width / 2) / current.zoom;
        const worldY = current.y + (previousAnchor.y - canvasSize.height / 2) / current.zoom;
        return clampViewport(
          {
            x: worldX - (nextAnchor.x - canvasSize.width / 2) / zoom,
            y: worldY - (nextAnchor.y - canvasSize.height / 2) / zoom,
            zoom,
          },
          canvasSize,
        );
      });
      pointerRef.current = {
        kind: "pinch",
        lastCenter: pinch.center,
        lastDistance: pinch.distance,
      };
      return;
    }

    if (pointer.kind === "draw") {
      continueDrawingAt(event.clientX, event.clientY, pointer);
      return;
    }

    if (pointer.kind === "tap-tool") return;

    if (pointer.kind === "shape") {
      continueShapeAt(event.clientX, event.clientY, pointer);
      return;
    }

    if (pointer.kind === "select") {
      const pixel = getPixelAt(event.clientX, event.clientY);
      if (pixel) setSelection(clampSelectionToCanvas(selectionBounds(pointer.anchor, pixel)));
      return;
    }

    if (pointer.kind === "move-selection") {
      const pixel = getPixelAt(event.clientX, event.clientY);
      if (!pixel || !movingSelection) return;
      const { originalBounds } = movingSelection;
      const dx = pixel.x - pointer.anchor.x;
      const dy = pixel.y - pointer.anchor.y;
      setSelection({
        minX: originalBounds.minX + dx,
        minY: originalBounds.minY + dy,
        maxX: originalBounds.maxX + dx,
        maxY: originalBounds.maxY + dy,
      });
      return;
    }

    const hasDragged =
      pointer.hasDragged ||
      Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) >= DRAG_THRESHOLD;
    if (!hasDragged) return;

    const deltaX = event.clientX - pointer.lastX;
    const deltaY = event.clientY - pointer.lastY;
    pointerRef.current = {
      ...pointer,
      lastX: event.clientX,
      lastY: event.clientY,
      hasDragged: true,
    };
    setViewport((current) =>
      clampViewport(
        {
          ...current,
          x: current.x - deltaX / current.zoom,
          y: current.y - deltaY / current.zoom,
        },
        canvasSize,
      ),
    );
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>, cancelled = false) => {
    const activePointer = pointerRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    touchPointsRef.current.delete(event.pointerId);
    if (cancelled) {
      if (activePointer?.kind === "select") setSelection(selectionBeforeTouchRef.current);
      if (activePointer?.kind === "move-selection" && movingSelection) {
        setSelection(movingSelection.originalBounds);
      }
      for (const pointerId of touchPointsRef.current.keys()) {
        if (event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId);
      }
      touchPointsRef.current.clear();
      selectionBeforeTouchRef.current = null;
      setShapePreview([]);
      setTouchPreview([]);
      setMovingSelection(null);
      pointerRef.current = null;
      setIsPanning(false);
      return;
    }
    if (activePointer && "pointerId" in activePointer && activePointer.pointerId !== event.pointerId) {
      return;
    }
    if (pointerRef.current?.kind === "pinch") {
      const pinch = getPinchMetrics(touchPointsRef.current);
      if (pinch) {
        pointerRef.current = {
          kind: "pinch",
          lastCenter: pinch.center,
          lastDistance: pinch.distance,
        };
      } else {
        const remainingTouch = Array.from(touchPointsRef.current.entries())[0];
        pointerRef.current = remainingTouch
          ? {
              kind: "pan",
              pointerId: remainingTouch[0],
              startX: remainingTouch[1].x,
              startY: remainingTouch[1].y,
              lastX: remainingTouch[1].x,
              lastY: remainingTouch[1].y,
              hasDragged: true,
              button: 0,
            }
          : null;
        setIsPanning(Boolean(remainingTouch));
      }
      return;
    }
    if (pointerRef.current?.kind === "draw") {
      const pointer = pointerRef.current;
      const pendingChanges = pointer.pendingChanges;
      if (pendingChanges) {
        dispatch({ type: "paint", changes: pendingChanges });
        keepUsedColor(pointer.color);
        setTouchPreview([]);
        setActivity(
          `You ${pointer.color === EMPTY_PIXEL ? "erased" : "painted"} ${pendingChanges.length} pixel${pendingChanges.length === 1 ? "" : "s"}.`,
        );
      }
    }
    if (pointerRef.current?.kind === "tap-tool") {
      const pointer = pointerRef.current;
      if (pointer.tool === "fill") fillAt(pointer.clientX, pointer.clientY);
      else pickColorAt(pointer.clientX, pointer.clientY);
    }
    if (pointerRef.current?.kind === "shape") {
      const pointer = pointerRef.current;
      const endpoint = getPixelAt(event.clientX, event.clientY) ?? pointer.current;
      const changes = pixelsInShape(
        pointer.tool,
        pointer.anchor,
        endpoint,
        pointer.style,
        pointer.color,
        pointer.symmetry,
      );
      setShapePreview([]);
      if (!changes) {
        setActivity(`Shape is too large. Stamps are limited to ${MAX_SHAPE_PIXELS} pixels.`);
      } else {
        dispatch({ type: "paint", changes });
        keepUsedColor(pointer.color);
        const label = pointer.tool === "rectangle" ? "rectangle" : pointer.tool;
        setActivity(
          `Stamped a ${pointer.style === "filled" && pointer.tool !== "line" ? "filled " : ""}${label} with ${changes.length} pixel${changes.length === 1 ? "" : "s"}.`,
        );
      }
    }
    if (pointerRef.current?.kind === "select") {
      const pixel = getPixelAt(event.clientX, event.clientY);
      if (pixel) {
        const bounds = clampSelectionToCanvas(selectionBounds(pointerRef.current.anchor, pixel));
        const width = bounds.maxX - bounds.minX + 1;
        const height = bounds.maxY - bounds.minY + 1;
        if (width === 1 && height === 1) {
          setSelection(null);
          setActivity("Selection dismissed.");
        } else {
          setSelection(bounds);
          setActivity(`Selected ${width} by ${height} pixels.`);
        }
      }
      selectionBeforeTouchRef.current = null;
    }
    if (pointerRef.current?.kind === "move-selection" && movingSelection) {
      const pointer = pointerRef.current;
      const pixel = getPixelAt(event.clientX, event.clientY);
      const dx = pixel ? pixel.x - pointer.anchor.x : 0;
      const dy = pixel ? pixel.y - pointer.anchor.y : 0;
      const { originalBounds, captured } = movingSelection;
      if (dx !== 0 || dy !== 0) {
        const nextSelection = {
          minX: originalBounds.minX + dx,
          minY: originalBounds.minY + dy,
          maxX: originalBounds.maxX + dx,
          maxY: originalBounds.maxY + dy,
        };
        const changes = captured.pixels.map(({ x, y, color }) => ({
          x: originalBounds.minX + x + dx,
          y: originalBounds.minY + y + dy,
          color,
        }));
        dispatch({
          type: "move",
          from: originalBounds,
          changes,
          selectionBefore: originalBounds,
          selectionAfter: nextSelection,
        });
        setSelection(nextSelection);
        setActivity(`Moved a ${captured.width} by ${captured.height} selection.`);
      }
      setMovingSelection(null);
    }
    if (pointerRef.current?.kind === "pan" && pointerRef.current.button === 2) {
      if (pointerRef.current.hasDragged) rightDragEndedAtRef.current = performance.now();
      else openCanvasMenuAt(event.clientX, event.clientY);
    }
    pointerRef.current = null;
    setIsPanning(false);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (event: WheelEvent) => {
      interruptView.current();
      event.preventDefault();
      setCanvasMenu(null);
      setDockPanel(null);
      const bounds = canvas.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? canvasSize.height
            : 1;
      let deltaX = event.deltaX * unit;
      let deltaY = event.deltaY * unit;
      if (event.ctrlKey) {
        const factor = Math.exp(Math.max(-0.24, Math.min(0.24, -deltaY * 0.01)));
        setViewport((current) => {
          const zoom = clampZoom(current.zoom * factor, fitZoomFor(canvasSize));
          if (zoom === current.zoom) return current;
          const worldX = current.x + (anchor.x - canvasSize.width / 2) / current.zoom;
          const worldY = current.y + (anchor.y - canvasSize.height / 2) / current.zoom;
          return clampViewport(
            {
              x: worldX - (anchor.x - canvasSize.width / 2) / zoom,
              y: worldY - (anchor.y - canvasSize.height / 2) / zoom,
              zoom,
            },
            canvasSize,
          );
        });
        return;
      }
      if (event.shiftKey && deltaX === 0) {
        deltaX = deltaY;
        deltaY = 0;
      }
      setViewport((current) =>
        clampViewport(
          {
            ...current,
            x: current.x + deltaX / current.zoom,
            y: current.y + deltaY / current.zoom,
          },
          canvasSize,
        ),
      );
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [canvasSize]);

  const handleCanvasKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomTo(viewport.zoom * 1.2);
    }
    if (event.key === "-") {
      event.preventDefault();
      zoomTo(viewport.zoom / 1.2);
    }
    if (event.key === "0") {
      event.preventDefault();
      setViewport({ x: 0, y: 0, zoom: DEFAULT_ZOOM });
    }
  };

  return {
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
    handleCanvasKeyDown,
    openCanvasMenuAt,
  };
}
