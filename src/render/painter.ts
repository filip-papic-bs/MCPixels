import {
  CANVAS_MAX,
  CANVAS_MIN,
  CANVAS_SIZE,
  EMPTY_PIXEL,
  GRID_LINE_ZOOM,
  clampZoom,
  isOnCanvas,
  supportsSymmetry,
  visibleRegion,
} from "../pixels.ts";
import type { MovingSelection, PixelChange, SelectionBounds, Symmetry, Tool, ViewSize, Viewport } from "../pixels.ts";
import { packCells } from "./pack.ts";

export type PaintCaches = { grid: HTMLCanvasElement | null; image: ImageData | null };

export const createPaintCaches = (): PaintCaches => ({ grid: null, image: null });

export type Scene = {
  cells: Uint32Array;
  viewport: Viewport;
  view: ViewSize;
  fitZoom: number;
  selection: SelectionBounds | null;
  movingSelection: MovingSelection | null;
  shapePreview: PixelChange[];
  touchPreview: PixelChange[];
  tool: Tool;
  symmetry: Symmetry;
};

export function paintCanvas(canvas: HTMLCanvasElement, scene: Scene, caches: PaintCaches) {
  const { cells, viewport, view, fitZoom, selection, movingSelection, shapePreview, touchPreview, tool, symmetry } =
    scene;
  const { width, height } = view;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const { x: centerX, y: centerY } = viewport;
  const zoom = clampZoom(viewport.zoom, fitZoom);
  const { minX, maxX, minY, maxY } = visibleRegion(viewport, view, fitZoom, 1);
  const screenX = (x: number) => (x - centerX) * zoom + width / 2;
  const screenY = (y: number) => (y - centerY) * zoom + height / 2;

  context.imageSmoothingEnabled = false;
  context.fillStyle = "#eceae2";
  context.fillRect(0, 0, width, height);

  const paperLeft = screenX(CANVAS_MIN);
  const paperTop = screenY(CANVAS_MIN);
  context.fillStyle = "#fafaf7";
  context.fillRect(paperLeft, paperTop, CANVAS_SIZE * zoom, CANVAS_SIZE * zoom);

  const firstX = Math.max(CANVAS_MIN, minX);
  const lastX = Math.min(CANVAS_MAX, maxX);
  const firstY = Math.max(CANVAS_MIN, minY);
  const lastY = Math.min(CANVAS_MAX, maxY);
  const movingFrom = movingSelection?.originalBounds ?? null;
  const columns = lastX - firstX + 1;
  const rows = lastY - firstY + 1;

  if (columns > 0 && rows > 0) {
    let offscreen = caches.grid;
    if (!offscreen) {
      offscreen = document.createElement("canvas");
      caches.grid = offscreen;
    }
    if (offscreen.width !== columns || offscreen.height !== rows) {
      offscreen.width = columns;
      offscreen.height = rows;
      caches.image = null;
    }
    const offscreenContext = offscreen.getContext("2d");
    if (offscreenContext) {
      let image = caches.image;
      if (!image) {
        image = offscreenContext.createImageData(columns, rows);
        caches.image = image;
      }
      image.data.fill(0);
      packCells(
        cells,
        { minX: firstX, minY: firstY, maxX: lastX, maxY: lastY },
        firstX,
        firstY,
        columns,
        image.data,
        movingFrom,
      );
      offscreenContext.putImageData(image, 0, 0);
      context.drawImage(offscreen, screenX(firstX), screenY(firstY), columns * zoom, rows * zoom);
    }
  }

  if (movingSelection && selection) {
    for (const { x, y, color } of movingSelection.captured.pixels) {
      const targetX = selection.minX + x;
      const targetY = selection.minY + y;
      if (targetX < minX || targetX > maxX || targetY < minY || targetY > maxY) continue;
      context.fillStyle = color;
      context.fillRect(screenX(targetX), screenY(targetY), zoom, zoom);
    }
  }

  context.globalAlpha = 0.58;
  for (const { x, y, color } of shapePreview) {
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    context.fillStyle = color;
    context.fillRect(screenX(x), screenY(y), zoom, zoom);
  }
  context.globalAlpha = 1;
  for (const { x, y, color } of touchPreview) {
    if (!isOnCanvas(x, y)) continue;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    if (color === EMPTY_PIXEL) {
      context.fillStyle = "#fafaf7";
      context.fillRect(screenX(x), screenY(y), zoom, zoom);
      continue;
    }
    context.fillStyle = color;
    context.fillRect(screenX(x), screenY(y), zoom, zoom);
  }

  if (zoom >= GRID_LINE_ZOOM) {
    context.beginPath();
    context.strokeStyle = "#d5d7d2";
    context.lineWidth = 1;
    for (let x = firstX; x <= lastX + 1; x += 1) {
      const position = Math.round(screenX(x)) + 0.5;
      context.moveTo(position, Math.max(0, paperTop));
      context.lineTo(position, Math.min(height, screenY(CANVAS_MAX + 1)));
    }
    for (let y = firstY; y <= lastY + 1; y += 1) {
      const position = Math.round(screenY(y)) + 0.5;
      context.moveTo(Math.max(0, paperLeft), position);
      context.lineTo(Math.min(width, screenX(CANVAS_MAX + 1)), position);
    }
    context.stroke();
  }

  context.lineWidth = 1;
  context.beginPath();
  context.strokeStyle = supportsSymmetry(tool) && symmetry.vertical ? "#ef5938" : "#aeb2ac";
  context.moveTo(screenX(0), 0);
  context.lineTo(screenX(0), height);
  context.stroke();
  context.beginPath();
  context.strokeStyle = supportsSymmetry(tool) && symmetry.horizontal ? "#ef5938" : "#aeb2ac";
  context.moveTo(0, screenY(0));
  context.lineTo(width, screenY(0));
  context.stroke();

  context.lineWidth = 2;
  context.strokeStyle = "#9a9d95";
  context.strokeRect(paperLeft, paperTop, CANVAS_SIZE * zoom, CANVAS_SIZE * zoom);
}
