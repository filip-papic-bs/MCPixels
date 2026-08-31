import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";

const EMPTY_PIXEL = "transparent";
const EMPTY_CELL = 0;
const CANVAS_SIZE = 1024;
const CANVAS_MIN = -CANVAS_SIZE / 2;
const CANVAS_MAX = CANVAS_SIZE / 2 - 1;
const MIN_ZOOM = 0.1;
const GRID_LINE_ZOOM = 8;
const MAX_ZOOM = 64;
const DEFAULT_ZOOM = 22;
const DRAG_THRESHOLD = 5;
const STORAGE_KEY = "mcpixels.editor.v1";
const STORAGE_VERSION = 2;
const MAX_STORED_BYTES = 1_200_000;
const DEFAULT_EXPORT_SCALE = 8;
const MAX_EXPORT_SCALE = 64;
const MAX_EXPORT_DIMENSION = 4096;
const MAX_IMPORT_SOURCE_DIMENSION = 4096;
const MAX_IMPORT_DIMENSION = 256;
const IMPORT_ALPHA_THRESHOLD = 128;
const IMPORT_MATCH_TOLERANCE = 16;
const MIN_IMPORT_CELL_SIZE = 2;
const IMPORT_EDGE_CELL_BIAS = 0.15;
const HISTORY_LIMIT = 100;
const HISTORY_CELL_LIMIT = 2_000_000;
const MAX_SHAPE_PIXELS = 50_000;
const MAX_CUSTOM_COLORS = 8;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const PALETTE = [
  "#161616",
  "#f5f1e8",
  "#ff5c35",
  "#ffbd2e",
  "#45b86b",
  "#2d7ff9",
  "#7557d3",
  "#e54888",
];

type PixelChange = { x: number; y: number; color: string };
type PixelAction =
  | { type: "paint"; changes: PixelChange[]; historyGroup?: number }
  | { type: "clear-area"; bounds: SelectionBounds }
  | {
      type: "move";
      from: SelectionBounds;
      changes: PixelChange[];
      selectionBefore: SelectionBounds;
      selectionAfter: SelectionBounds;
    }
  | { type: "clear" }
  | { type: "undo" }
  | { type: "redo" };
type PixelPatch = {
  indices: number[];
  before: number[];
  after: number[];
  historyGroup: number | null;
  selectionBefore?: SelectionBounds;
  selectionAfter?: SelectionBounds;
};
type HistoryState = { version: number; undoDepth: number; redoDepth: number };
type Viewport = { x: number; y: number; zoom: number };
type SelectionBounds = { minX: number; minY: number; maxX: number; maxY: number };
type CopiedSelection = { pixels: PixelChange[]; width: number; height: number; origin: ScreenPoint };
type MovingSelection = { originalBounds: SelectionBounds; captured: CopiedSelection };
type ScreenPoint = { x: number; y: number };
type ShapeTool = "line" | "rectangle" | "ellipse";
type ColorTool = "paint" | "fill" | ShapeTool;
type Tool = ColorTool | "erase" | "picker" | "pan" | "select";
type ShapeStyle = "outline" | "filled";
type Symmetry = { horizontal: boolean; vertical: boolean };
type ExportMode = "scale" | "dimensions";
type ImportGrid = {
  columns: number;
  rows: number;
  originX: number;
  originY: number;
  pitch: number;
};
type ImportSource = ImportGrid & {
  name: string;
  data: Uint8ClampedArray;
  width: number;
  height: number;
};
type FillResult = {
  changes: PixelChange[];
  reason?: "same-color" | "off-canvas";
};
type PersistedEditorState = {
  cells: Uint32Array;
  viewport: Viewport;
  selectedColor: string;
  customColors: string[];
};
type PointerState =
  | {
      kind: "draw";
      pointerId: number;
      lastPixel: ScreenPoint;
      historyGroup: number;
      color: string;
      symmetry: Symmetry;
      pendingChanges?: PixelChange[];
    }
  | {
      kind: "shape";
      pointerId: number;
      anchor: ScreenPoint;
      current: ScreenPoint;
      tool: ShapeTool;
      color: string;
      style: ShapeStyle;
      symmetry: Symmetry;
    }
  | { kind: "select"; pointerId: number; anchor: { x: number; y: number } }
  | { kind: "move-selection"; pointerId: number; anchor: { x: number; y: number } }
  | { kind: "tap-tool"; pointerId: number; tool: "fill" | "picker"; clientX: number; clientY: number }
  | { kind: "pinch"; lastCenter: ScreenPoint; lastDistance: number }
  | {
      kind: "pan";
      pointerId: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      hasDragged: boolean;
      button: number;
    }
  | null;

const isOnCanvas = (x: number, y: number) =>
  x >= CANVAS_MIN && x <= CANVAS_MAX && y >= CANVAS_MIN && y <= CANVAS_MAX;

const cellIndex = (x: number, y: number) => (y - CANVAS_MIN) * CANVAS_SIZE + (x - CANVAS_MIN);

const cellX = (index: number) => (index % CANVAS_SIZE) + CANVAS_MIN;

const cellY = (index: number) => Math.floor(index / CANVAS_SIZE) + CANVAS_MIN;

const cellFromColor = (color: string) => (0xff000000 | parseInt(color.slice(1), 16)) >>> 0;

const colorFromCell = (cell: number) => `#${((cell & 0xffffff) | 0x1000000).toString(16).slice(1)}`;

const clampToCanvas = (value: number) => Math.max(CANVAS_MIN, Math.min(CANVAS_MAX, value));

function clampSelectionToCanvas(bounds: SelectionBounds): SelectionBounds {
  return {
    minX: clampToCanvas(bounds.minX),
    minY: clampToCanvas(bounds.minY),
    maxX: clampToCanvas(bounds.maxX),
    maxY: clampToCanvas(bounds.maxY),
  };
}

const TOOL_SHORTCUTS: Record<string, Tool> = {
  b: "paint",
  e: "erase",
  g: "fill",
  i: "picker",
  h: "pan",
  m: "select",
  l: "line",
  r: "rectangle",
  o: "ellipse",
};

type ShapeOption = {
  key: string;
  tool: ShapeTool;
  style: ShapeStyle | null;
  label: string;
  shortcut: string;
  icon: ReactElement;
};

const SHAPE_OPTIONS: ShapeOption[] = [
  {
    key: "line",
    tool: "line",
    style: null,
    label: "Line",
    shortcut: "L",
    icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19 19 5" /></svg>,
  },
  {
    key: "rectangle-outline",
    tool: "rectangle",
    style: "outline",
    label: "Rectangle outline",
    shortcut: "R",
    icon: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6.5" width="16" height="11" /></svg>,
  },
  {
    key: "rectangle-filled",
    tool: "rectangle",
    style: "filled",
    label: "Filled rectangle",
    shortcut: "R",
    icon: <svg className="filled-shape-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6.5" width="16" height="11" /></svg>,
  },
  {
    key: "ellipse-outline",
    tool: "ellipse",
    style: "outline",
    label: "Ellipse outline",
    shortcut: "O",
    icon: <svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="12" rx="8" ry="5.5" /></svg>,
  },
  {
    key: "ellipse-filled",
    tool: "ellipse",
    style: "filled",
    label: "Filled ellipse",
    shortcut: "O",
    icon: <svg className="filled-shape-icon" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="12" rx="8" ry="5.5" /></svg>,
  },
];

function isShapeOptionActive(option: ShapeOption, tool: Tool, style: ShapeStyle) {
  if (option.tool !== tool) return false;
  return option.style === null || option.style === style;
}

function isColorTool(tool: Tool): tool is ColorTool {
  return tool === "paint" || tool === "fill" || tool === "line" || tool === "rectangle" || tool === "ellipse";
}

function isShapeTool(tool: Tool): tool is ShapeTool {
  return tool === "line" || tool === "rectangle" || tool === "ellipse";
}

function supportsSymmetry(tool: Tool) {
  return tool === "paint" || tool === "erase" || tool === "fill" || isShapeTool(tool);
}

type PixelStore = {
  cells: Uint32Array;
  undoStack: PixelPatch[];
  redoStack: PixelPatch[];
  cellCount: number;
};

function createPixelStore(cells: Uint32Array): PixelStore {
  return { cells, undoStack: [], redoStack: [], cellCount: 0 };
}

function recordCell(patch: PixelPatch, index: number, before: number, after: number) {
  patch.indices.push(index);
  patch.before.push(before);
  patch.after.push(after);
}

function trimHistory(store: PixelStore) {
  while (store.undoStack.length > HISTORY_LIMIT || (store.cellCount > HISTORY_CELL_LIMIT && store.undoStack.length > 1)) {
    const dropped = store.undoStack.shift();
    if (!dropped) return;
    store.cellCount -= dropped.indices.length;
  }
}

function writeCell(store: PixelStore, patch: PixelPatch, x: number, y: number, value: number) {
  if (!isOnCanvas(x, y)) return;
  const index = cellIndex(x, y);
  const before = store.cells[index];
  if (before === value) return;
  store.cells[index] = value;
  recordCell(patch, index, before, value);
}

function clearArea(store: PixelStore, patch: PixelPatch, bounds: SelectionBounds) {
  const area = clampSelectionToCanvas(bounds);
  for (let y = area.minY; y <= area.maxY; y += 1) {
    for (let x = area.minX; x <= area.maxX; x += 1) {
      writeCell(store, patch, x, y, EMPTY_CELL);
    }
  }
}

function applyPixelChanges(store: PixelStore, patch: PixelPatch, changes: PixelChange[]) {
  for (const { x, y, color } of changes) {
    writeCell(store, patch, x, y, color === EMPTY_PIXEL ? EMPTY_CELL : cellFromColor(color));
  }
}

function applyPixelAction(store: PixelStore, action: PixelAction) {
  if (action.type === "undo") {
    const patch = store.undoStack.pop();
    if (!patch) return false;
    for (let entry = patch.indices.length - 1; entry >= 0; entry -= 1) {
      store.cells[patch.indices[entry]] = patch.before[entry];
    }
    store.redoStack.push(patch);
    return true;
  }

  if (action.type === "redo") {
    const patch = store.redoStack.pop();
    if (!patch) return false;
    for (let entry = 0; entry < patch.indices.length; entry += 1) {
      store.cells[patch.indices[entry]] = patch.after[entry];
    }
    store.undoStack.push(patch);
    return true;
  }

  const historyGroup = action.type === "paint" ? action.historyGroup ?? null : null;
  const open = store.undoStack.at(-1);
  const continues = historyGroup !== null && open !== undefined && open.historyGroup === historyGroup;
  const patch: PixelPatch = continues && open ? open : { indices: [], before: [], after: [], historyGroup };
  const started = patch.indices.length;

  if (action.type === "clear") {
    for (let index = 0; index < store.cells.length; index += 1) {
      const before = store.cells[index];
      if (before === EMPTY_CELL) continue;
      store.cells[index] = EMPTY_CELL;
      recordCell(patch, index, before, EMPTY_CELL);
    }
  } else if (action.type === "clear-area") {
    clearArea(store, patch, action.bounds);
  } else if (action.type === "move") {
    clearArea(store, patch, action.from);
    applyPixelChanges(store, patch, action.changes);
    patch.selectionBefore = action.selectionBefore;
    patch.selectionAfter = action.selectionAfter;
  } else {
    applyPixelChanges(store, patch, action.changes);
  }

  const written = patch.indices.length - started;
  if (written === 0) return false;
  for (const dropped of store.redoStack) store.cellCount -= dropped.indices.length;
  store.redoStack.length = 0;
  store.cellCount += written;
  if (!continues) store.undoStack.push(patch);
  trimHistory(store);
  return true;
}

function readPaintedPixels(cells: Uint32Array) {
  const painted: { x: number; y: number; color: string }[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    if (cells[index] === EMPTY_CELL) continue;
    painted.push({ x: cellX(index), y: cellY(index), color: colorFromCell(cells[index]) });
  }
  return painted;
}

function countPaintedCells(cells: Uint32Array, bounds?: SelectionBounds) {
  let painted = 0;
  if (!bounds) {
    for (let index = 0; index < cells.length; index += 1) if (cells[index] !== EMPTY_CELL) painted += 1;
    return painted;
  }
  const area = clampSelectionToCanvas(bounds);
  for (let y = area.minY; y <= area.maxY; y += 1) {
    for (let x = area.minX; x <= area.maxX; x += 1) {
      if (cells[cellIndex(x, y)] !== EMPTY_CELL) painted += 1;
    }
  }
  return painted;
}

function isCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= CANVAS_MIN && Number(value) <= CANVAS_MAX;
}

function clampZoom(zoom: number, minZoom = MIN_ZOOM) {
  return Math.min(MAX_ZOOM, Math.max(minZoom, zoom));
}

function fitZoomFor(view: { width: number; height: number }) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(view.width, view.height) / CANVAS_SIZE));
}

function clampViewport(viewport: Viewport, view?: { width: number; height: number }): Viewport {
  const zoom = clampZoom(viewport.zoom, view ? fitZoomFor(view) : MIN_ZOOM);
  const axis = (value: number, extent: number) => {
    if (extent > 0 && CANVAS_SIZE * zoom <= extent) return 0;
    return Math.max(CANVAS_MIN, Math.min(CANVAS_MAX + 1, value));
  };
  return {
    zoom,
    x: axis(viewport.x, view ? view.width : 0),
    y: axis(viewport.y, view ? view.height : 0),
  };
}

function selectionBounds(from: { x: number; y: number }, to: { x: number; y: number }): SelectionBounds {
  return {
    minX: Math.min(from.x, to.x),
    minY: Math.min(from.y, to.y),
    maxX: Math.max(from.x, to.x),
    maxY: Math.max(from.y, to.y),
  };
}

function floodFill(cells: Uint32Array, start: ScreenPoint, color: string): FillResult {
  if (!isOnCanvas(start.x, start.y)) return { changes: [], reason: "off-canvas" };
  const target = cells[cellIndex(start.x, start.y)];
  const replacement = cellFromColor(color);
  if (target === replacement) return { changes: [], reason: "same-color" };

  const queue = [cellIndex(start.x, start.y)];
  const visited = new Uint8Array(cells.length);
  visited[queue[0]] = 1;
  const changes: PixelChange[] = [];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const index = queue[queueIndex];
    queueIndex += 1;
    const x = cellX(index);
    const y = cellY(index);
    changes.push({ x, y, color });

    const neighbors = [
      { x: x - 1, y },
      { x: x + 1, y },
      { x, y: y - 1 },
      { x, y: y + 1 },
    ];
    for (const neighbor of neighbors) {
      if (!isOnCanvas(neighbor.x, neighbor.y)) continue;
      const neighborIndex = cellIndex(neighbor.x, neighbor.y);
      if (visited[neighborIndex] || cells[neighborIndex] !== target) continue;
      visited[neighborIndex] = 1;
      queue.push(neighborIndex);
    }
  }

  return { changes };
}

function getPinchMetrics(points: Map<number, ScreenPoint>) {
  const [first, second] = Array.from(points.values());
  if (!first || !second) return null;
  return {
    center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
  };
}

function readStoredColors(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  const colors: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !COLOR_PATTERN.test(entry)) continue;
    const color = entry.toLowerCase();
    if (!colors.includes(color)) colors.push(color);
    if (colors.length === limit) break;
  }
  return colors;
}

function writeVarint(bytes: number[], value: number) {
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
}

function readVarint(bytes: Uint8Array, cursor: { at: number }) {
  let value = 0;
  let shift = 0;
  while (cursor.at < bytes.length) {
    const byte = bytes[cursor.at];
    cursor.at += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

function encodeCells(cells: Uint32Array) {
  const palette: string[] = [];
  const indexes = new Map<number, number>();
  const bytes: number[] = [];
  let runCell = cells[0];
  let runLength = 0;

  const flush = () => {
    if (runLength === 0) return true;
    let index = 0;
    if (runCell !== EMPTY_CELL) {
      const known = indexes.get(runCell);
      if (known === undefined) {
        palette.push(colorFromCell(runCell));
        index = palette.length;
        indexes.set(runCell, index);
      } else {
        index = known;
      }
    }
    writeVarint(bytes, index);
    writeVarint(bytes, runLength);
    return bytes.length <= MAX_STORED_BYTES;
  };

  for (let at = 0; at < cells.length; at += 1) {
    if (cells[at] === runCell) {
      runLength += 1;
      continue;
    }
    if (!flush()) return null;
    runCell = cells[at];
    runLength = 1;
  }
  if (!flush()) return null;
  return { palette, runs: bytesToBase64(Uint8Array.from(bytes)) };
}

function decodeCells(palette: unknown, runs: unknown) {
  if (!Array.isArray(palette) || typeof runs !== "string") return null;
  const colors = palette.map((color) =>
    typeof color === "string" && COLOR_PATTERN.test(color) ? cellFromColor(color.toLowerCase()) : EMPTY_CELL,
  );
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(runs);
  } catch {
    return null;
  }
  const cells = new Uint32Array(CANVAS_SIZE * CANVAS_SIZE);
  const cursor = { at: 0 };
  let filled = 0;

  while (cursor.at < bytes.length) {
    const index = readVarint(bytes, cursor);
    const length = readVarint(bytes, cursor);
    if (index === null || length === null || index > colors.length) return null;
    if (filled + length > cells.length) return null;
    if (index > 0) cells.fill(colors[index - 1], filled, filled + length);
    filled += length;
  }
  return filled === cells.length ? cells : null;
}

function loadPersistedState(): PersistedEditorState {
  const fallback: PersistedEditorState = {
    cells: new Uint32Array(CANVAS_SIZE * CANVAS_SIZE),
    viewport: { x: 0, y: 0, zoom: DEFAULT_ZOOM },
    selectedColor: PALETTE[0],
    customColors: [],
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    let cells: Uint32Array | null = null;

    if (saved.version === STORAGE_VERSION && saved.canvas === CANVAS_SIZE) {
      cells = decodeCells(saved.palette, saved.runs);
    } else if (saved.version === 1 && Array.isArray(saved.pixels)) {
      cells = new Uint32Array(CANVAS_SIZE * CANVAS_SIZE);
      for (const entry of saved.pixels) {
        if (!Array.isArray(entry) || entry.length !== 3) continue;
        const [x, y, color] = entry as unknown[];
        if (isCoordinate(x) && isCoordinate(y) && typeof color === "string" && COLOR_PATTERN.test(color)) {
          cells[cellIndex(x, y)] = cellFromColor(color.toLowerCase());
        }
      }
    }
    if (!cells) return fallback;

    const savedViewport = saved.viewport as Record<string, unknown> | undefined;
    const viewport =
      savedViewport &&
      typeof savedViewport.x === "number" &&
      Number.isFinite(savedViewport.x) &&
      typeof savedViewport.y === "number" &&
      Number.isFinite(savedViewport.y) &&
      typeof savedViewport.zoom === "number" &&
      Number.isFinite(savedViewport.zoom)
        ? clampViewport({ x: savedViewport.x, y: savedViewport.y, zoom: savedViewport.zoom })
        : fallback.viewport;
    const selectedColor =
      typeof saved.selectedColor === "string" && COLOR_PATTERN.test(saved.selectedColor)
        ? saved.selectedColor.toLowerCase()
        : fallback.selectedColor;
    const storedCustomColors = [
      ...readStoredColors(saved.recentColors, MAX_CUSTOM_COLORS),
      ...readStoredColors(saved.customColors, MAX_CUSTOM_COLORS),
    ].filter((color) => !PALETTE.includes(color));
    const customColors = [
      ...(PALETTE.includes(selectedColor) ? [] : [selectedColor]),
      ...storedCustomColors,
    ].filter((color, index, colors) => colors.indexOf(color) === index).slice(0, MAX_CUSTOM_COLORS);

    return { cells, viewport, selectedColor, customColors };
  } catch (error) {
    console.warn("Could not restore the saved MCPixels canvas", error);
    return fallback;
  }
}

function pixelsOnLine(from: { x: number; y: number }, to: { x: number; y: number }, color: string) {
  const changes: PixelChange[] = [];
  let x = from.x;
  let y = from.y;
  const deltaX = Math.abs(to.x - from.x);
  const deltaY = Math.abs(to.y - from.y);
  const stepX = from.x < to.x ? 1 : -1;
  const stepY = from.y < to.y ? 1 : -1;
  let error = deltaX - deltaY;

  while (true) {
    changes.push({ x, y, color });
    if (x === to.x && y === to.y) return changes;
    const doubledError = error * 2;
    if (doubledError > -deltaY) {
      error -= deltaY;
      x += stepX;
    }
    if (doubledError < deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
}

function applySymmetry(changes: PixelChange[], symmetry: Symmetry, limit = Number.POSITIVE_INFINITY) {
  const mirrored = new Map<string, PixelChange>();
  for (const change of changes) {
    const xCoordinates = symmetry.vertical ? [change.x, -change.x - 1] : [change.x];
    const yCoordinates = symmetry.horizontal ? [change.y, -change.y - 1] : [change.y];
    for (const x of xCoordinates) {
      for (const y of yCoordinates) {
        mirrored.set(`${x},${y}`, { x, y, color: change.color });
        if (mirrored.size > limit) return null;
      }
    }
  }
  return Array.from(mirrored.values());
}

function pixelsInShape(
  tool: ShapeTool,
  from: ScreenPoint,
  to: ScreenPoint,
  style: ShapeStyle,
  color: string,
  symmetry: Symmetry,
) {
  if (tool === "line") {
    const pixelCount = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) + 1;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_SHAPE_PIXELS) return null;
    return applySymmetry(pixelsOnLine(from, to, color), symmetry, MAX_SHAPE_PIXELS);
  }

  const bounds = selectionBounds(from, to);
  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
  const changes: PixelChange[] = [];

  if (tool === "rectangle") {
    const pixelCount = style === "filled"
      ? width * height
      : width === 1
        ? height
        : height === 1
          ? width
          : width * 2 + (height - 2) * 2;
    if (pixelCount > MAX_SHAPE_PIXELS) return null;

    if (style === "filled") {
      for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
        for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
          changes.push({ x, y, color });
        }
      }
    } else {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        changes.push({ x, y: bounds.minY, color });
        if (bounds.maxY !== bounds.minY) changes.push({ x, y: bounds.maxY, color });
      }
      for (let y = bounds.minY + 1; y < bounds.maxY; y += 1) {
        changes.push({ x: bounds.minX, y, color });
        if (bounds.maxX !== bounds.minX) changes.push({ x: bounds.maxX, y, color });
      }
    }
  } else {
    if (width * height > MAX_SHAPE_PIXELS) return null;
    const centerX = (bounds.minX + bounds.maxX + 1) / 2;
    const centerY = (bounds.minY + bounds.maxY + 1) / 2;
    const radiusX = width / 2;
    const radiusY = height / 2;
    const isInside = (x: number, y: number) => {
      if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) return false;
      const normalizedX = (x + 0.5 - centerX) / radiusX;
      const normalizedY = (y + 0.5 - centerY) / radiusY;
      return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
    };

    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        if (!isInside(x, y)) continue;
        if (
          style === "filled" ||
          !isInside(x - 1, y) ||
          !isInside(x + 1, y) ||
          !isInside(x, y - 1) ||
          !isInside(x, y + 1)
        ) {
          changes.push({ x, y, color });
        }
      }
    }
  }

  return applySymmetry(changes, symmetry, MAX_SHAPE_PIXELS);
}

function sourcePixelDistance(data: Uint8ClampedArray, a: number, b: number) {
  const alphaDistance = Math.abs(data[a + 3] - data[b + 3]);
  if (data[a + 3] < IMPORT_ALPHA_THRESHOLD && data[b + 3] < IMPORT_ALPHA_THRESHOLD) return alphaDistance;
  return Math.max(
    alphaDistance,
    Math.abs(data[a] - data[b]),
    Math.abs(data[a + 1] - data[b + 1]),
    Math.abs(data[a + 2] - data[b + 2]),
  );
}

function lineBreaks(
  data: Uint8ClampedArray,
  size: number,
  otherSize: number,
  indexOf: (line: number, offset: number) => number,
) {
  const isBreak = new Uint8Array(size);
  const energy = new Float64Array(size);
  for (let line = 1; line < size; line += 1) {
    let peak = 0;
    let total = 0;
    for (let offset = 0; offset < otherSize; offset += 1) {
      const distance = sourcePixelDistance(data, indexOf(line - 1, offset), indexOf(line, offset));
      if (distance > peak) peak = distance;
      total += distance;
    }
    isBreak[line] = peak > IMPORT_MATCH_TOLERANCE ? 1 : 0;
    energy[line] = total;
  }
  let drift = 0;
  for (let offset = 0; offset < otherSize; offset += 1) {
    drift = Math.max(drift, sourcePixelDistance(data, indexOf(0, offset), indexOf(size - 1, offset)));
  }
  return { isBreak, energy, drift };
}

function breakCenters(isBreak: Uint8Array, energy: Float64Array) {
  const centers: number[] = [];
  let widest = 0;
  let start = -1;
  for (let line = 0; line <= isBreak.length; line += 1) {
    if (line < isBreak.length && isBreak[line]) {
      if (start < 0) start = line;
      continue;
    }
    if (start < 0) continue;
    let weight = 0;
    let weighted = 0;
    for (let inner = start; inner < line; inner += 1) {
      weight += energy[inner];
      weighted += energy[inner] * inner;
    }
    centers.push(weight > 0 ? weighted / weight : start);
    widest = Math.max(widest, line - start);
    start = -1;
  }
  return { centers, widest };
}

function gridFit(centers: number[], pitch: number) {
  let sines = 0;
  let cosines = 0;
  for (const center of centers) {
    const angle = (Math.PI * 2 * center) / pitch;
    sines += Math.sin(angle);
    cosines += Math.cos(angle);
  }
  const phase = (Math.atan2(sines, cosines) * pitch) / (Math.PI * 2);
  let worst = 0;
  let total = 0;
  for (const center of centers) {
    const offset = center - phase;
    const residual = Math.abs(offset - Math.round(offset / pitch) * pitch);
    if (residual > worst) worst = residual;
    total += residual;
  }
  return { phase, worst, mean: total / centers.length };
}

function fitPitch(centers: number[], count: number, pitch: number, phase: number) {
  let indexTotal = 0;
  let centerTotal = 0;
  let squareTotal = 0;
  let productTotal = 0;
  for (let entry = 0; entry < count; entry += 1) {
    const index = Math.round((centers[entry] - phase) / pitch);
    indexTotal += index;
    centerTotal += centers[entry];
    squareTotal += index * index;
    productTotal += index * centers[entry];
  }
  const spread = count * squareTotal - indexTotal * indexTotal;
  if (spread === 0) return null;
  const next = (count * productTotal - indexTotal * centerTotal) / spread;
  if (!(next > 0)) return null;
  return { pitch: next, phase: (centerTotal - next * indexTotal) / count };
}

function refinePitch(centers: number[], guess: number) {
  let pitch = guess;
  let phase = centers[0];
  for (let count = Math.min(centers.length, 4); ; count = Math.min(centers.length, count * 2)) {
    for (let pass = 0; pass < 3; pass += 1) {
      const fit = fitPitch(centers, count, pitch, phase);
      if (!fit) break;
      const settled = Math.abs(fit.pitch - pitch) < 1e-6;
      pitch = fit.pitch;
      phase = fit.phase;
      if (settled) break;
    }
    if (count >= centers.length) return pitch;
  }
}

function pitchCandidates(centers: number[]) {
  if (centers.length < 2) return [];
  const gaps: number[] = [];
  for (let index = 1; index < centers.length; index += 1) gaps.push(centers[index] - centers[index - 1]);
  gaps.sort((a, b) => a - b);
  const guesses = [gaps[0], gaps[Math.floor(gaps.length / 2)]];
  return guesses
    .filter((guess) => guess >= MIN_IMPORT_CELL_SIZE)
    .map((guess) => refinePitch(centers, guess))
    .filter((pitch) => pitch >= MIN_IMPORT_CELL_SIZE);
}

function axisAccepts(breaks: { centers: number[]; widest: number }, pitch: number) {
  if (breaks.centers.length === 0) return { origin: 0 };
  if (breaks.widest > pitch * 0.85) return null;
  const fit = gridFit(breaks.centers, pitch);
  if (fit.worst > Math.min(pitch * 0.25, Math.max(0.85, pitch * 0.08))) return null;
  if (fit.mean > Math.min(pitch * 0.12, Math.max(0.35, pitch * 0.04))) return null;
  return { origin: fit.phase };
}

function detectPixelGrid(data: Uint8ClampedArray, width: number, height: number): ImportGrid {
  const fullSize = { columns: width, rows: height, originX: 0, originY: 0, pitch: 1 };
  const columnLines = lineBreaks(data, width, height, (x, y) => (y * width + x) * 4);
  const rowLines = lineBreaks(data, height, width, (y, x) => (y * width + x) * 4);
  const columnBreaks = breakCenters(columnLines.isBreak, columnLines.energy);
  const rowBreaks = breakCenters(rowLines.isBreak, rowLines.energy);

  if (columnBreaks.centers.length === 0 && rowBreaks.centers.length === 0) {
    const flat = columnLines.drift <= IMPORT_MATCH_TOLERANCE && rowLines.drift <= IMPORT_MATCH_TOLERANCE;
    return flat ? { columns: 1, rows: 1, originX: 0, originY: 0, pitch: 1 } : fullSize;
  }
  if (columnBreaks.centers.length === 0 && columnLines.drift > IMPORT_MATCH_TOLERANCE) return fullSize;
  if (rowBreaks.centers.length === 0 && rowLines.drift > IMPORT_MATCH_TOLERANCE) return fullSize;

  const candidates = [...pitchCandidates(columnBreaks.centers), ...pitchCandidates(rowBreaks.centers)].sort(
    (a, b) => b - a,
  );
  for (const pitch of candidates) {
    const columnFit = axisAccepts(columnBreaks, pitch);
    const rowFit = axisAccepts(rowBreaks, pitch);
    if (!columnFit || !rowFit) continue;
    const columns = Math.max(1, Math.round((width - columnFit.origin) / pitch + IMPORT_EDGE_CELL_BIAS));
    const rows = Math.max(1, Math.round((height - rowFit.origin) / pitch + IMPORT_EDGE_CELL_BIAS));
    if (columns >= width && rows >= height) break;
    return { columns, rows, originX: columnFit.origin, originY: rowFit.origin, pitch };
  }
  return fullSize;
}

function rasterizeImportSource(source: ImportSource, width: number, height: number) {
  const detected = width === source.columns && height === source.rows;
  const cellWidth = detected ? source.pitch : source.width / width;
  const cellHeight = detected ? source.pitch : source.height / height;
  const originX = detected ? source.originX : 0;
  const originY = detected ? source.originY : 0;
  const insetX = Math.min(cellWidth / 4, 2);
  const insetY = Math.min(cellHeight / 4, 2);
  const changes: PixelChange[] = [];
  const counts = new Map<number, number>();

  for (let y = 0; y < height; y += 1) {
    const topEdge = originY + y * cellHeight;
    const top = Math.max(0, Math.min(source.height - 1, Math.floor(topEdge + insetY)));
    const bottom = Math.max(top, Math.min(source.height - 1, Math.ceil(topEdge + cellHeight - insetY) - 1));
    for (let x = 0; x < width; x += 1) {
      const leftEdge = originX + x * cellWidth;
      const left = Math.max(0, Math.min(source.width - 1, Math.floor(leftEdge + insetX)));
      const right = Math.max(left, Math.min(source.width - 1, Math.ceil(leftEdge + cellWidth - insetX) - 1));

      counts.clear();
      let bestColor = -1;
      let bestCount = 0;
      for (let sourceY = top; sourceY <= bottom; sourceY += 1) {
        for (let sourceX = left; sourceX <= right; sourceX += 1) {
          const index = (sourceY * source.width + sourceX) * 4;
          const color =
            source.data[index + 3] < IMPORT_ALPHA_THRESHOLD
              ? -1
              : (source.data[index] << 16) | (source.data[index + 1] << 8) | source.data[index + 2];
          const count = (counts.get(color) ?? 0) + 1;
          counts.set(color, count);
          if (count > bestCount) {
            bestCount = count;
            bestColor = color;
          }
        }
      }
      if (bestColor < 0) continue;
      changes.push({ x, y, color: `#${(bestColor | 0x1000000).toString(16).slice(1)}` });
    }
  }
  return changes;
}

function fitImportDimensions(width: number, height: number) {
  const factor = Math.min(1, MAX_IMPORT_DIMENSION / width, MAX_IMPORT_DIMENSION / height);
  if (factor >= 1) return { width, height };
  return {
    width: Math.max(1, Math.floor(width * factor)),
    height: Math.max(1, Math.floor(height * factor)),
  };
}

async function decodeImageFile(file: File) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return { image: bitmap as CanvasImageSource, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return {
      image: image as CanvasImageSource,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function readImportSource(file: File): Promise<ImportSource> {
  if (file.type && !file.type.startsWith("image/")) throw new Error("That file is not an image.");
  const decoded = await decodeImageFile(file);
  try {
    const { width, height } = decoded;
    if (!width || !height) throw new Error("That image has no pixels to import.");
    if (width > MAX_IMPORT_SOURCE_DIMENSION || height > MAX_IMPORT_SOURCE_DIMENSION) {
      throw new Error(`Images must be at most ${MAX_IMPORT_SOURCE_DIMENSION}px per side.`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not create the import canvas");
    context.imageSmoothingEnabled = false;
    context.drawImage(decoded.image, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);
    return { name: file.name || "pasted image", data, width, height, ...detectPixelGrid(data, width, height) };
  } finally {
    decoded.release();
  }
}

function importOriginFor(selection: SelectionBounds | null, viewport: Viewport, width: number, height: number) {
  const clamp = (value: number, size: number) =>
    Math.max(CANVAS_MIN, Math.min(CANVAS_MAX - size + 1, value));
  return {
    x: clamp(selection ? selection.minX : Math.round(viewport.x) - Math.floor(width / 2), width),
    y: clamp(selection ? selection.minY : Math.round(viewport.y) - Math.floor(height / 2), height),
  };
}

function findImageFile(files: FileList | null | undefined, items?: DataTransferItemList | null) {
  for (const file of Array.from(files ?? [])) {
    if (file.type.startsWith("image/")) return file;
  }
  for (const item of Array.from(items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

function carriesFiles(transfer: DataTransfer | null) {
  return Array.from(transfer?.types ?? []).includes("Files");
}

type DockPanel = "color" | "shape" | "more" | null;
type CanvasMenu = { x: number; y: number } | null;

function App() {
  const [initialState] = useState(loadPersistedState);
  const storeRef = useRef<PixelStore | null>(null);
  if (storeRef.current === null) storeRef.current = createPixelStore(initialState.cells);
  const store = storeRef.current;
  const cells = store.cells;
  const [history, setHistory] = useState<HistoryState>({ version: 0, undoDepth: 0, redoDepth: 0 });

  const dispatch = (action: PixelAction) => {
    if (!applyPixelAction(store, action)) return;
    setHistory((current) => ({
      version: current.version + 1,
      undoDepth: store.undoStack.length,
      redoDepth: store.redoStack.length,
    }));
  };
  const [selectedColor, setSelectedColor] = useState(initialState.selectedColor);
  const [customColors, setCustomColors] = useState(initialState.customColors);
  const [tool, setTool] = useState<Tool>("paint");
  const [shapeStyle, setShapeStyle] = useState<ShapeStyle>("outline");
  const [symmetry, setSymmetry] = useState<Symmetry>({ horizontal: false, vertical: false });
  const [shapePreview, setShapePreview] = useState<PixelChange[]>([]);
  const [touchPreview, setTouchPreview] = useState<PixelChange[]>([]);
  const [viewport, setViewport] = useState<Viewport>(initialState.viewport);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const [activity, setActivity] = useState("Canvas ready. Pick a color and draw.");
  const [webMcpStatus, setWebMcpStatus] = useState<"checking" | "ready" | "unavailable" | "error">("checking");
  const [isPanning, setIsPanning] = useState(false);
  const [selection, setSelection] = useState<SelectionBounds | null>(null);
  const [movingSelection, setMovingSelection] = useState<MovingSelection | null>(null);
  const [copiedSelection, setCopiedSelection] = useState<CopiedSelection | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [exportMode, setExportMode] = useState<ExportMode>("scale");
  const [exportScale, setExportScale] = useState(DEFAULT_EXPORT_SCALE);
  const [exportDimensions, setExportDimensions] = useState({ width: 1, height: 1 });
  const [lockExportRatio, setLockExportRatio] = useState(true);
  const [exportError, setExportError] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importSource, setImportSource] = useState<ImportSource | null>(null);
  const [importDimensions, setImportDimensions] = useState({ width: 1, height: 1 });
  const [lockImportRatio, setLockImportRatio] = useState(true);
  const [importError, setImportError] = useState("");
  const [isReadingImport, setIsReadingImport] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [dockPanel, setDockPanel] = useState<DockPanel>(null);
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenu>(null);
  const [selectionActionsSize, setSelectionActionsSize] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasMenuRef = useRef<HTMLDivElement>(null);
  const selectionActionsRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef(viewport);
  const canvasSizeRef = useRef(canvasSize);
  const gridCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const gridImageRef = useRef<ImageData | null>(null);
  const encodedCellsRef = useRef<{ version: number; encoded: ReturnType<typeof encodeCells> } | null>(null);
  const pointerRef = useRef<PointerState>(null);
  const historyGroupRef = useRef(0);
  const toolBeforePickerRef = useRef<ColorTool>("paint");
  const touchPointsRef = useRef(new Map<number, ScreenPoint>());
  const shapePreviewFrameRef = useRef<number | null>(null);
  const spacePressedRef = useRef(false);
  const lastCanvasPointerRef = useRef<ScreenPoint | null>(null);
  const selectionBeforeTouchRef = useRef<SelectionBounds | null>(null);
  const rightDragEndedAtRef = useRef(0);
  const contextMenuOpenedAtRef = useRef(0);
  viewportRef.current = viewport;
  canvasSizeRef.current = canvasSize;
  const fitZoom = fitZoomFor(canvasSize);

  useEffect(() => {
    const save = () => {
      const cached = encodedCellsRef.current;
      const encoded = cached && cached.version === history.version ? cached.encoded : encodeCells(cells);
      encodedCellsRef.current = { version: history.version, encoded };
      if (!encoded) {
        setStorageError("This canvas is too detailed to save in this browser. Recent changes will be lost if you reload.");
        return;
      }
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: STORAGE_VERSION,
            canvas: CANVAS_SIZE,
            palette: encoded.palette,
            runs: encoded.runs,
            viewport,
            selectedColor,
            customColors,
          }),
        );
        setStorageError("");
      } catch (error) {
        console.warn("Could not save the MCPixels canvas", error);
        const size = Math.round(encoded.runs.length / 1024);
        setStorageError(`This browser refused to store the canvas (${size} KB). Recent changes will be lost if you reload.`);
      }
    };

    const timeout = window.setTimeout(save, 200);
    window.addEventListener("pagehide", save);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pagehide", save);
    };
  }, [cells, customColors, history.version, selectedColor, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(1, Math.floor(entry.contentRect.width));
      const height = Math.max(1, Math.floor(entry.contentRect.height));
      setCanvasSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setViewport((current) => {
      const next = clampViewport(current, canvasSize);
      return next.x === current.x && next.y === current.y && next.zoom === current.zoom ? current : next;
    });
  }, [canvasSize]);

  useEffect(() => {
    if (!canvasMenu) return;
    const frame = window.requestAnimationFrame(() => {
      canvasMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canvasMenu]);

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

    const { width, height } = canvasSize;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);

    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const { x: centerX, y: centerY } = viewport;
    const zoom = clampZoom(viewport.zoom, fitZoom);
    const minX = Math.floor(centerX - width / (2 * zoom)) - 1;
    const maxX = Math.ceil(centerX + width / (2 * zoom)) + 1;
    const minY = Math.floor(centerY - height / (2 * zoom)) - 1;
    const maxY = Math.ceil(centerY + height / (2 * zoom)) + 1;
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
      let offscreen = gridCanvasRef.current;
      if (!offscreen) {
        offscreen = document.createElement("canvas");
        gridCanvasRef.current = offscreen;
      }
      if (offscreen.width !== columns || offscreen.height !== rows) {
        offscreen.width = columns;
        offscreen.height = rows;
        gridImageRef.current = null;
      }
      const offscreenContext = offscreen.getContext("2d");
      if (offscreenContext) {
        let image = gridImageRef.current;
        if (!image) {
          image = offscreenContext.createImageData(columns, rows);
          gridImageRef.current = image;
        }
        const painted = image.data;
        painted.fill(0);
        for (let y = firstY; y <= lastY; y += 1) {
          const rowStart = (y - CANVAS_MIN) * CANVAS_SIZE - CANVAS_MIN;
          const target = (y - firstY) * columns - firstX;
          const skipRow = movingFrom !== null && y >= movingFrom.minY && y <= movingFrom.maxY;
          for (let x = firstX; x <= lastX; x += 1) {
            const cell = cells[rowStart + x];
            if (cell === EMPTY_CELL) continue;
            if (skipRow && movingFrom && x >= movingFrom.minX && x <= movingFrom.maxX) continue;
            const offset = (target + x) * 4;
            painted[offset] = (cell >>> 16) & 255;
            painted[offset + 1] = (cell >>> 8) & 255;
            painted[offset + 2] = cell & 255;
            painted[offset + 3] = 255;
          }
        }
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
  }, [canvasSize, cells, fitZoom, history.version, movingSelection, selection, shapePreview, symmetry, tool, touchPreview, viewport]);

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
    const changes = applySymmetry([{ ...pixel, color }], symmetry);
    if (!changes) return;
    historyGroupRef.current += 1;
    const historyGroup = historyGroupRef.current;
    pointerRef.current = {
      kind: "draw",
      pointerId,
      lastPixel: pixel,
      historyGroup,
      color,
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
    setActivity(`You ${tool === "erase" ? "erased" : "painted"} pixel (${pixel.x}, ${pixel.y}).`);
  };

  const continueDrawingAt = (clientX: number, clientY: number, pointer: Extract<PointerState, { kind: "draw" }>) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel || (pixel.x === pointer.lastPixel.x && pixel.y === pointer.lastPixel.y)) return;
    const changes = applySymmetry(pixelsOnLine(pointer.lastPixel, pixel, pointer.color), pointer.symmetry);
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

  const continueShapeAt = (
    clientX: number,
    clientY: number,
    pointer: Extract<PointerState, { kind: "shape" }>,
  ) => {
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
      setActivity(`Filled ${changes.length} pixel${changes.length === 1 ? "" : "s"}${regions > 1 ? ` across ${regions} mirrored regions` : ""}.`);
      return;
    }
    if (reason === "off-canvas") setActivity("That point is outside the canvas.");
    else setActivity("That area already uses the selected color.");
  };

  const selectEditorColor = (value: string) => {
    const color = value.toLowerCase();
    setSelectedColor(color);
    if (!PALETTE.includes(color)) {
      setCustomColors((current) => [color, ...current.filter((entry) => entry !== color)].slice(0, MAX_CUSTOM_COLORS));
    }
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
    const menuHeight = selection ? 276 : 216;
    setCanvasMenu({
      x: Math.max(8, Math.min(bounds.width - 190, clientX - bounds.left)),
      y: Math.max(8, Math.min(bounds.height - menuHeight - 68, clientY - bounds.top)),
    });
    contextMenuOpenedAtRef.current = performance.now();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
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
      event.button === 1 ||
      isContextClick ||
      tool === "pan" ||
      (event.button === 0 && spacePressedRef.current);
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
        pointerRef.current = { kind: "tap-tool", pointerId: event.pointerId, tool: "fill", clientX: event.clientX, clientY: event.clientY };
        return;
      }
      fillAt(event.clientX, event.clientY);
      return;
    }
    if (shouldPickColor) {
      if (isTouch) {
        pointerRef.current = { kind: "tap-tool", pointerId: event.pointerId, tool: "picker", clientX: event.clientX, clientY: event.clientY };
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
        return clampViewport({
          x: worldX - (nextAnchor.x - canvasSize.width / 2) / zoom,
          y: worldY - (nextAnchor.y - canvasSize.height / 2) / zoom,
          zoom,
        }, canvasSize);
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
      clampViewport({
        ...current,
        x: current.x - deltaX / current.zoom,
        y: current.y - deltaY / current.zoom,
      }, canvasSize),
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
        setTouchPreview([]);
        setActivity(`You ${pointer.color === EMPTY_PIXEL ? "erased" : "painted"} ${pendingChanges.length} pixel${pendingChanges.length === 1 ? "" : "s"}.`);
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
        const label = pointer.tool === "rectangle" ? "rectangle" : pointer.tool;
        setActivity(`Stamped a ${pointer.style === "filled" && pointer.tool !== "line" ? "filled " : ""}${label} with ${changes.length} pixel${changes.length === 1 ? "" : "s"}.`);
      }
    }
    if (pointerRef.current?.kind === "select") {
      const pixel = getPixelAt(event.clientX, event.clientY);
      if (pixel) {
        const bounds = clampSelectionToCanvas(selectionBounds(pointerRef.current.anchor, pixel));
        setSelection(bounds);
        const width = bounds.maxX - bounds.minX + 1;
        const height = bounds.maxY - bounds.minY + 1;
        setActivity(`Selected ${width} by ${height} pixels.`);
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

  const zoomTo = (nextZoom: number, point?: { x: number; y: number }) => {
    setViewport((current) => {
      const zoom = clampZoom(nextZoom, fitZoomFor(canvasSize));
      if (zoom === current.zoom) return current;
      const anchor = point ?? { x: canvasSize.width / 2, y: canvasSize.height / 2 };
      const worldX = current.x + (anchor.x - canvasSize.width / 2) / current.zoom;
      const worldY = current.y + (anchor.y - canvasSize.height / 2) / current.zoom;
      return clampViewport({
        x: worldX - (anchor.x - canvasSize.width / 2) / zoom,
        y: worldY - (anchor.y - canvasSize.height / 2) / zoom,
        zoom,
      }, canvasSize);
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setCanvasMenu(null);
      setDockPanel(null);
      const bounds = canvas.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
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
          return clampViewport({
            x: worldX - (anchor.x - canvasSize.width / 2) / zoom,
            y: worldY - (anchor.y - canvasSize.height / 2) / zoom,
            zoom,
          }, canvasSize);
        });
        return;
      }
      if (event.shiftKey && deltaX === 0) {
        deltaX = deltaY;
        deltaY = 0;
      }
      setViewport((current) =>
        clampViewport({
          ...current,
          x: current.x + deltaX / current.zoom,
          y: current.y + deltaY / current.zoom,
        }, canvasSize),
      );
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [canvasSize]);

  const handleCanvasKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setSelection(null);
      setActivity("Selection dismissed.");
      return;
    }
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

  useEffect(() => {
    const modelContext = document.modelContext;
    if (typeof modelContext?.registerTool !== "function") {
      setWebMcpStatus("unavailable");
      return;
    }

    const controller = new AbortController();
    const coordinateProperties = {
      x: { type: "integer", minimum: CANVAS_MIN, maximum: CANVAS_MAX },
      y: { type: "integer", minimum: CANVAS_MIN, maximum: CANVAS_MAX },
    };
    const coordinateSchema = {
      type: "object",
      properties: coordinateProperties,
      required: ["x", "y"],
      additionalProperties: false,
    };

    const registerTools = async () => {
      await Promise.all([
        modelContext.registerTool(
          {
            name: "get_sprite",
            title: "Read sprite",
            description: `Read every colored pixel on the ${CANVAS_SIZE} by ${CANVAS_SIZE} canvas and the current visible viewport. Coordinates run from ${CANVAS_MIN} to ${CANVAS_MAX} on both axes.`,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
            execute: async () => ({
              canvas: { width: CANVAS_SIZE, height: CANVAS_SIZE, minX: CANVAS_MIN, minY: CANVAS_MIN, maxX: CANVAS_MAX, maxY: CANVAS_MAX },
              viewport: viewportRef.current,
              coloredPixels: readPaintedPixels(store.cells),
            }),
          },
          { signal: controller.signal },
        ),
        modelContext.registerTool(
          {
            name: "paint_pixels",
            title: "Paint pixels",
            description: `Paint pixels anywhere on the ${CANVAS_SIZE} by ${CANVAS_SIZE} canvas. Coordinates run from ${CANVAS_MIN} to ${CANVAS_MAX} on both axes; colors must be six-digit hex values.`,
            inputSchema: {
              type: "object",
              properties: {
                pixels: {
                  type: "array",
                  minItems: 1,
                  maxItems: 512,
                  items: {
                    type: "object",
                    properties: {
                      ...coordinateProperties,
                      color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
                    },
                    required: ["x", "y", "color"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["pixels"],
              additionalProperties: false,
            },
            execute: async ({ pixels: inputPixels }) => {
              if (!Array.isArray(inputPixels) || inputPixels.length < 1 || inputPixels.length > 512) {
                throw new Error("pixels must contain between 1 and 512 entries");
              }
              const changes = inputPixels.map((pixel) => {
                if (typeof pixel !== "object" || pixel === null) throw new Error("Each pixel must be an object");
                const { x, y, color } = pixel as Record<string, unknown>;
                if (!isCoordinate(x) || !isCoordinate(y) || typeof color !== "string" || !COLOR_PATTERN.test(color)) {
                  throw new Error(`Invalid pixel: ${JSON.stringify(pixel)}. Coordinates run from ${CANVAS_MIN} to ${CANVAS_MAX} and colors must be six-digit hex.`);
                }
                return { x, y, color: color.toLowerCase() };
              });
              dispatch({ type: "paint", changes });
              setActivity(`Agent painted ${changes.length} pixel${changes.length === 1 ? "" : "s"}.`);
              return { success: true, painted: changes.length };
            },
          },
          { signal: controller.signal },
        ),
        modelContext.registerTool(
          {
            name: "erase_pixels",
            title: "Erase pixels",
            description: `Erase pixels on the ${CANVAS_SIZE} by ${CANVAS_SIZE} canvas, at coordinates from ${CANVAS_MIN} to ${CANVAS_MAX} on both axes.`,
            inputSchema: {
              type: "object",
              properties: {
                pixels: { type: "array", minItems: 1, maxItems: 512, items: coordinateSchema },
              },
              required: ["pixels"],
              additionalProperties: false,
            },
            execute: async ({ pixels: inputPixels }) => {
              if (!Array.isArray(inputPixels) || inputPixels.length < 1 || inputPixels.length > 512) {
                throw new Error("pixels must contain between 1 and 512 entries");
              }
              const changes = inputPixels.map((pixel) => {
                if (typeof pixel !== "object" || pixel === null) throw new Error("Each pixel must be an object");
                const { x, y } = pixel as Record<string, unknown>;
                if (!isCoordinate(x) || !isCoordinate(y)) {
                  throw new Error(`Invalid pixel: ${JSON.stringify(pixel)}. Coordinates run from ${CANVAS_MIN} to ${CANVAS_MAX}.`);
                }
                return { x, y, color: EMPTY_PIXEL };
              });
              dispatch({ type: "paint", changes });
              setActivity(`Agent erased ${changes.length} pixel${changes.length === 1 ? "" : "s"}.`);
              return { success: true, erased: changes.length };
            },
          },
          { signal: controller.signal },
        ),
        modelContext.registerTool(
          {
            name: "set_canvas_view",
            title: "Move canvas view",
            description: `Center the visible canvas on a coordinate from ${CANVAS_MIN} to ${CANVAS_MAX} and set its zoom from ${MIN_ZOOM} to ${MAX_ZOOM} pixels per cell.`,
            inputSchema: {
              type: "object",
              properties: {
                x: coordinateProperties.x,
                y: coordinateProperties.y,
                zoom: { type: "number", minimum: MIN_ZOOM, maximum: MAX_ZOOM },
              },
              required: ["x", "y", "zoom"],
              additionalProperties: false,
            },
            execute: async ({ x, y, zoom }) => {
              if (!isCoordinate(x) || !isCoordinate(y) || typeof zoom !== "number" || !Number.isFinite(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) {
                throw new Error(`Invalid canvas view. Coordinates run from ${CANVAS_MIN} to ${CANVAS_MAX}.`);
              }
              const next = clampViewport({ x, y, zoom }, canvasSizeRef.current);
              setViewport(next);
              setActivity(`Agent centered the view at (${next.x}, ${next.y}).`);
              return { success: true, viewport: next };
            },
          },
          { signal: controller.signal },
        ),
        modelContext.registerTool(
          {
            name: "clear_sprite",
            title: "Clear sprite",
            description: "Erase every colored pixel from the canvas.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => {
              const cleared = countPaintedCells(store.cells);
              dispatch({ type: "clear" });
              setActivity("Agent cleared the canvas.");
              return { success: true, cleared };
            },
          },
          { signal: controller.signal },
        ),
      ]);
      setWebMcpStatus("ready");
    };

    void registerTools().catch((error: unknown) => {
      if (!controller.signal.aborted) {
        console.error("WebMCP tool registration failed", error);
        setWebMcpStatus("error");
      }
    });
    return () => controller.abort();
  }, []);

  const statusText = {
    checking: "Checking WebMCP",
    ready: "5 agent tools ready",
    unavailable: "Best in ChatGPT browser",
    error: "Tool registration failed",
  }[webMcpStatus];
  const paletteColors = [...customColors, ...PALETTE].slice(0, PALETTE.length);
  const symmetryEnabled = supportsSymmetry(tool);

  const selectionScreen = selection
    ? {
        left: (selection.minX - viewport.x) * viewport.zoom + canvasSize.width / 2,
        top: (selection.minY - viewport.y) * viewport.zoom + canvasSize.height / 2,
        width: (selection.maxX - selection.minX + 1) * viewport.zoom,
        height: (selection.maxY - selection.minY + 1) * viewport.zoom,
      }
    : null;
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
        const requestedTop = aboveSpace >= height || aboveSpace >= belowSpace
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
  const importDetectedSize = importSource ? { width: importSource.columns, height: importSource.rows } : null;
  const importFoundGrid = Boolean(
    importSource && (importSource.columns < importSource.width || importSource.rows < importSource.height),
  );
  const importFittedSize = importDetectedSize
    ? fitImportDimensions(importDetectedSize.width, importDetectedSize.height)
    : null;
  const importSizeError =
    importSource && (importDimensions.width > MAX_IMPORT_DIMENSION || importDimensions.height > MAX_IMPORT_DIMENSION)
      ? `Imports must be at most ${MAX_IMPORT_DIMENSION} pixels per side.`
      : "";
  const importOrigin = importOriginFor(selection, viewport, importDimensions.width, importDimensions.height);

  const clearSelection = () => {
    if (!selection) return;
    const cleared = countPaintedCells(store.cells, selection);
    dispatch({ type: "clear-area", bounds: selection });
    setSelection(null);
    setActivity(`Cleared ${cleared} pixel${cleared === 1 ? "" : "s"} from the selection.`);
  };

  const captureSelection = () => {
    if (!selection) return null;
    const copiedPixels: PixelChange[] = [];
    const area = clampSelectionToCanvas(selection);
    for (let y = area.minY; y <= area.maxY; y += 1) {
      for (let x = area.minX; x <= area.maxX; x += 1) {
        const cell = store.cells[cellIndex(x, y)];
        if (cell === EMPTY_CELL) continue;
        copiedPixels.push({ x: x - selection.minX, y: y - selection.minY, color: colorFromCell(cell) });
      }
    }
    const width = selection.maxX - selection.minX + 1;
    const height = selection.maxY - selection.minY + 1;
    return { pixels: copiedPixels, width, height, origin: { x: selection.minX, y: selection.minY } };
  };

  const copySelection = () => {
    const copied = captureSelection();
    if (!copied) return;
    setCopiedSelection(copied);
    setActivity(`Copied ${copied.pixels.length} pixel${copied.pixels.length === 1 ? "" : "s"} from a ${copied.width} by ${copied.height} selection.`);
  };

  const cutSelection = () => {
    if (!selection) return;
    const copied = captureSelection();
    if (!copied) return;
    setCopiedSelection(copied);
    dispatch({ type: "clear-area", bounds: selection });
    setActivity(`Cut ${copied.pixels.length} pixel${copied.pixels.length === 1 ? "" : "s"} from a ${copied.width} by ${copied.height} selection.`);
  };

  const pasteSelection = () => {
    if (!copiedSelection) return;
    const requestedOrigin = lastCanvasPointerRef.current ?? copiedSelection.origin;
    const origin = {
      x: Math.max(CANVAS_MIN, Math.min(CANVAS_MAX - copiedSelection.width + 1, requestedOrigin.x)),
      y: Math.max(CANVAS_MIN, Math.min(CANVAS_MAX - copiedSelection.height + 1, requestedOrigin.y)),
    };
    const changes = copiedSelection.pixels.map(({ x, y, color }) => ({
      x: origin.x + x,
      y: origin.y + y,
      color,
    }));
    if (changes.length > 0) dispatch({ type: "paint", changes });
    setSelection({
      minX: origin.x,
      minY: origin.y,
      maxX: origin.x + copiedSelection.width - 1,
      maxY: origin.y + copiedSelection.height - 1,
    });
    setActivity(`Pasted ${changes.length} pixel${changes.length === 1 ? "" : "s"} from a ${copiedSelection.width} by ${copiedSelection.height} copy at (${origin.x}, ${origin.y}).`);
  };

  const moveSelectionBy = (dx: number, dy: number) => {
    if (!selection) return;
    if (
      selection.minX + dx < CANVAS_MIN ||
      selection.maxX + dx > CANVAS_MAX ||
      selection.minY + dy < CANVAS_MIN ||
      selection.maxY + dy > CANVAS_MAX
    ) {
      setActivity("The selection is already at the canvas edge.");
      return;
    }
    const captured = captureSelection();
    if (!captured) return;
    const nextSelection = {
      minX: selection.minX + dx,
      minY: selection.minY + dy,
      maxX: selection.maxX + dx,
      maxY: selection.maxY + dy,
    };
    const changes = captured.pixels.map(({ x, y, color }) => ({
      x: nextSelection.minX + x,
      y: nextSelection.minY + y,
      color,
    }));
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
    setActivity(`Moved the selection by ${dx !== 0 ? `${Math.abs(dx)} pixel ${dx < 0 ? "left" : "right"}` : `${Math.abs(dy)} pixel ${dy < 0 ? "up" : "down"}`}.`);
  };

  const transformSelection = (
    mapPixel: (x: number, y: number, width: number, height: number) => { x: number; y: number },
    nextDimensions: (width: number, height: number) => { width: number; height: number },
    label: string,
  ) => {
    if (!selection) return;
    const captured = captureSelection();
    if (!captured) return;
    const { width, height } = captured;
    const { width: nextWidth, height: nextHeight } = nextDimensions(width, height);
    const changes = captured.pixels.map(({ x, y, color }) => {
      const mapped = mapPixel(x, y, width, height);
      return { x: selection.minX + mapped.x, y: selection.minY + mapped.y, color };
    });
    const nextSelection = {
      minX: selection.minX,
      minY: selection.minY,
      maxX: selection.minX + nextWidth - 1,
      maxY: selection.minY + nextHeight - 1,
    };
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

  const flipSelectionHorizontal = () =>
    transformSelection(
      (x, y, width) => ({ x: width - 1 - x, y }),
      (width, height) => ({ width, height }),
      "Flipped horizontally",
    );

  const flipSelectionVertical = () =>
    transformSelection(
      (x, y, _width, height) => ({ x, y: height - 1 - y }),
      (width, height) => ({ width, height }),
      "Flipped vertically",
    );

  const rotateSelectionClockwise = () =>
    transformSelection(
      (x, y, _width, height) => ({ x: height - 1 - y, y: x }),
      (width, height) => ({ width: height, height: width }),
      "Rotated",
    );

  const openExportPanel = () => {
    if (!selectionSize) return;
    const scale = Math.min(DEFAULT_EXPORT_SCALE, maxExportScale);
    setExportMode("scale");
    setExportScale(scale);
    setExportDimensions({ width: selectionSize.width * scale, height: selectionSize.height * scale });
    setLockExportRatio(true);
    setExportError("");
    setShowExport(true);
  };

  const closeExportPanel = () => {
    setShowExport(false);
    setSelection(null);
    setExportError("");
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
      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = selectionSize.width;
      sourceCanvas.height = selectionSize.height;
      const sourceContext = sourceCanvas.getContext("2d");
      if (!sourceContext) throw new Error("Could not create the export canvas");

      const area = clampSelectionToCanvas(selection);
      for (let y = area.minY; y <= area.maxY; y += 1) {
        for (let x = area.minX; x <= area.maxX; x += 1) {
          const cell = store.cells[cellIndex(x, y)];
          if (cell === EMPTY_CELL) continue;
          sourceContext.fillStyle = colorFromCell(cell);
          sourceContext.fillRect(x - selection.minX, y - selection.minY, 1, 1);
        }
      }

      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = exportOutputSize.width;
      outputCanvas.height = exportOutputSize.height;
      const outputContext = outputCanvas.getContext("2d");
      if (!outputContext) throw new Error("Could not create the scaled export canvas");
      outputContext.imageSmoothingEnabled = false;
      outputContext.drawImage(sourceCanvas, 0, 0, exportOutputSize.width, exportOutputSize.height);

      const blob = await new Promise<Blob>((resolve, reject) => {
        outputCanvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error("Could not encode the PNG"));
        }, "image/png");
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `mcpixels-${exportOutputSize.width}x${exportOutputSize.height}.png`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setShowExport(false);
      setSelection(null);
      setActivity(`Exported a ${exportOutputSize.width} by ${exportOutputSize.height} PNG.`);
    } catch (error) {
      console.error("Could not export the MCPixels selection", error);
      setExportError(error instanceof Error ? error.message : "Could not export the selection");
    } finally {
      setIsExporting(false);
    }
  };

  const readImportFile = async (file: File | null) => {
    if (!file) return;
    setShowExport(false);
    setShowImport(true);
    setImportSource(null);
    setImportError("");
    setIsReadingImport(true);
    try {
      const source = await readImportSource(file);
      setImportSource(source);
      setImportDimensions(fitImportDimensions(source.columns, source.rows));
      setLockImportRatio(true);
      setActivity(
        source.columns < source.width || source.rows < source.height
          ? `Read ${source.name}: ${source.width} by ${source.height} pixels holding a ${source.columns} by ${source.rows} pixel grid.`
          : `Read ${source.name}: ${source.width} by ${source.height} pixels, no pixel grid detected.`,
      );
    } catch (error) {
      console.error("Could not read the image to import", error);
      setImportError(error instanceof Error ? error.message : "Could not read that image");
    } finally {
      setIsReadingImport(false);
    }
  };

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select") || target?.isContentEditable) return;
      const file = findImageFile(event.clipboardData?.files, event.clipboardData?.items);
      if (file) {
        event.preventDefault();
        void readImportFile(file);
        return;
      }
      if (showExport || showImport || !copiedSelection) return;
      event.preventDefault();
      pasteSelection();
    };
    const blockFileDrop = (event: DragEvent) => {
      if (carriesFiles(event.dataTransfer)) event.preventDefault();
    };
    window.addEventListener("paste", handlePaste);
    window.addEventListener("dragover", blockFileDrop);
    window.addEventListener("drop", blockFileDrop);
    return () => {
      window.removeEventListener("paste", handlePaste);
      window.removeEventListener("dragover", blockFileDrop);
      window.removeEventListener("drop", blockFileDrop);
    };
  }, [copiedSelection, showExport, showImport]);

  const updateImportWidth = (value: number) => {
    if (!importDetectedSize) return;
    let width = Math.min(MAX_IMPORT_DIMENSION, Math.max(1, Math.round(value) || 1));
    let height = lockImportRatio
      ? Math.max(1, Math.round(width * (importDetectedSize.height / importDetectedSize.width)))
      : importDimensions.height;
    if (height > MAX_IMPORT_DIMENSION) {
      height = MAX_IMPORT_DIMENSION;
      width = Math.max(1, Math.round(height * (importDetectedSize.width / importDetectedSize.height)));
    }
    setImportDimensions({ width, height });
    setImportError("");
  };

  const updateImportHeight = (value: number) => {
    if (!importDetectedSize) return;
    let height = Math.min(MAX_IMPORT_DIMENSION, Math.max(1, Math.round(value) || 1));
    let width = lockImportRatio
      ? Math.max(1, Math.round(height * (importDetectedSize.width / importDetectedSize.height)))
      : importDimensions.width;
    if (width > MAX_IMPORT_DIMENSION) {
      width = MAX_IMPORT_DIMENSION;
      height = Math.max(1, Math.round(width * (importDetectedSize.height / importDetectedSize.width)));
    }
    setImportDimensions({ width, height });
    setImportError("");
  };

  const updateImportRatioLock = (locked: boolean) => {
    setLockImportRatio(locked);
    if (!locked || !importDetectedSize) return;
    let width = importDimensions.width;
    let height = Math.max(1, Math.round(width * (importDetectedSize.height / importDetectedSize.width)));
    if (height > MAX_IMPORT_DIMENSION) {
      height = MAX_IMPORT_DIMENSION;
      width = Math.max(1, Math.round(height * (importDetectedSize.width / importDetectedSize.height)));
    }
    setImportDimensions({ width, height });
  };

  const closeImportPanel = () => {
    setShowImport(false);
    setImportSource(null);
    setImportError("");
    setActivity("Import cancelled.");
  };

  const placeImportedImage = () => {
    if (!importSource || importSizeError) return;
    const { width, height } = importDimensions;
    const origin = importOriginFor(selection, viewport, width, height);
    const changes = rasterizeImportSource(importSource, width, height).map(({ x, y, color }) => ({
      x: origin.x + x,
      y: origin.y + y,
      color,
    }));
    if (changes.length === 0) {
      setImportError("Every pixel in that image is transparent.");
      return;
    }
    dispatch({ type: "paint", changes });
    setSelection({ minX: origin.x, minY: origin.y, maxX: origin.x + width - 1, maxY: origin.y + height - 1 });
    setShowImport(false);
    setImportSource(null);
    setActivity(`Imported ${changes.length} pixel${changes.length === 1 ? "" : "s"} as a ${width} by ${height} image at (${origin.x}, ${origin.y}).`);
  };

  const dismissSelection = () => {
    setShowExport(false);
    setSelection(null);
    setActivity("Selection dismissed.");
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

  useEffect(() => {
    const panelOpen = showExport || showImport;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select") || target?.isContentEditable;
      const modifierPressed = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const wantsUndo = modifierPressed && key === "z" && !event.shiftKey;
      const wantsRedo = modifierPressed && ((key === "z" && event.shiftKey) || key === "y");

      if (!isTyping && key === "escape" && (dockPanel || canvasMenu)) {
        event.preventDefault();
        setDockPanel(null);
        setCanvasMenu(null);
        return;
      }

      if (!panelOpen && !isTyping && wantsUndo && history.undoDepth > 0) {
        event.preventDefault();
        undoPixels();
        return;
      }
      if (!panelOpen && !isTyping && wantsRedo && history.redoDepth > 0) {
        event.preventDefault();
        redoPixels();
        return;
      }
      if (!panelOpen && !isTyping && modifierPressed && !event.shiftKey && !event.altKey && !event.repeat) {
        if (key === "c" && selection) {
          event.preventDefault();
          copySelection();
          return;
        }
        if (key === "x" && selection) {
          event.preventDefault();
          cutSelection();
          return;
        }
      }
      const arrowMoves: Record<string, ScreenPoint | undefined> = {
        arrowleft: { x: -1, y: 0 },
        arrowright: { x: 1, y: 0 },
        arrowup: { x: 0, y: -1 },
        arrowdown: { x: 0, y: 1 },
      };
      const arrowMove = !modifierPressed && !event.altKey ? arrowMoves[key] : undefined;
      if (!panelOpen && !isTyping && arrowMove) {
        event.preventDefault();
        if (selection) {
          moveSelectionBy(arrowMove.x, arrowMove.y);
        } else {
          setViewport((current) =>
            clampViewport({
              ...current,
              x: current.x + (arrowMove.x * 40) / current.zoom,
              y: current.y + (arrowMove.y * 40) / current.zoom,
            }, canvasSize),
          );
          setActivity(`Panned ${key.slice(5)}.`);
        }
        return;
      }
      const shortcutTool = !modifierPressed && !event.altKey ? TOOL_SHORTCUTS[key] : undefined;
      if (!panelOpen && !isTyping && !event.repeat && shortcutTool) {
        event.preventDefault();
        if (shortcutTool === "picker" && tool !== "picker") {
          toolBeforePickerRef.current = isColorTool(tool) ? tool : "paint";
        }
        setTool(shortcutTool);
        setDockPanel(null);
        setCanvasMenu(null);
        setActivity(`${shortcutTool === "paint" ? "Draw" : shortcutTool[0].toUpperCase() + shortcutTool.slice(1)} tool selected.`);
        return;
      }
      if (event.code !== "Space" || event.repeat || isTyping || target?.matches("button")) return;
      spacePressedRef.current = true;
      event.preventDefault();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spacePressedRef.current = false;
    };
    const handleBlur = () => {
      spacePressedRef.current = false;
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [canvasMenu, canvasSize, copiedSelection, dockPanel, history.redoDepth, history.undoDepth, selection, showExport, showImport, tool]);

  return (
    <main className="app-shell">
      <header className="masthead">
        <a className="wordmark" href="/" aria-label="MCPixels home">
          <span className="wordmark-mcp">MCP</span><span className="wordmark-tail">ixels</span>
        </a>
        <div className="masthead-status">
          {storageError ? (
            <div className="save-warning" role="status" title={storageError}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 2.5 14.5 13.5h-13zM8 6.5v3.5M8 11.8v.7" />
              </svg>
              Not saved
            </div>
          ) : null}
          <div className={`agent-status agent-status--${webMcpStatus}`} title={statusText}>
            <span aria-hidden="true" />
            {statusText}
          </div>
        </div>
      </header>

      <section className="editor" aria-label="MCPixels editor">
        <div className="bottom-controls" onPointerDown={() => setCanvasMenu(null)}>
          {dockPanel === "color" ? (
            <section className="dock-popover dock-popover--color" aria-label="Color palette">
              <header><span>Color</span><strong>{selectedColor}</strong></header>
              <div className="palette">
                {paletteColors.map((color, index) => (
                  <button
                    key={index}
                    className={selectedColor === color ? "swatch swatch--active" : "swatch"}
                    style={{ backgroundColor: color }}
                    type="button"
                    aria-label={`Use color ${color}`}
                    aria-pressed={selectedColor === color}
                    onClick={() => {
                      selectEditorColor(color);
                      if (!isColorTool(tool)) setTool("paint");
                    }}
                  />
                ))}
                <label className="custom-color" title="Choose a custom color">
                  <span>+</span>
                  <input
                    type="color"
                    value={selectedColor}
                    aria-label="Choose a custom color"
                    onChange={(event) => {
                      selectEditorColor(event.target.value);
                      if (!isColorTool(tool)) setTool("paint");
                    }}
                  />
                </label>
                <button
                  className={tool === "picker" ? "color-picker-button color-picker-button--active" : "color-picker-button"}
                  type="button"
                  aria-label="Pick color from canvas"
                  aria-pressed={tool === "picker"}
                  aria-keyshortcuts="I"
                  title="Pick color (I)"
                  onClick={() => {
                    if (tool !== "picker") toolBeforePickerRef.current = isColorTool(tool) ? tool : "paint";
                    setTool("picker");
                    setDockPanel(null);
                  }}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 2 5 5-2.5 2.5-1-1-7 7H3v-3.5l7-7-1-1zM6 15H3" /></svg>
                </button>
              </div>
            </section>
          ) : null}

          {dockPanel === "shape" ? (
            <section className="dock-popover dock-popover--shape" aria-label="Shape settings">
              <header>
                <span>Shape</span>
                <strong>{SHAPE_OPTIONS.find((option) => isShapeOptionActive(option, tool, shapeStyle))?.label ?? "Line"}</strong>
              </header>
              <div className="popover-shapes">
                {SHAPE_OPTIONS.map((option) => {
                  const active = isShapeOptionActive(option, tool, shapeStyle);
                  return (
                    <button
                      key={option.key}
                      className={active ? "popover-option popover-option--active" : "popover-option"}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={active}
                      aria-keyshortcuts={option.shortcut}
                      title={`${option.label} (${option.shortcut})`}
                      onClick={() => {
                        setTool(option.tool);
                        if (option.style) setShapeStyle(option.style);
                      }}
                    >
                      {option.icon}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          {dockPanel === "more" ? (
            <section className="dock-popover dock-popover--more" aria-label="More canvas controls">
              <header><span>Files</span><strong>Canvas</strong></header>
              <div className="popover-grid popover-grid--files popover-grid--icon-actions">
                <button
                  type="button"
                  aria-label="Import image"
                  title="Import image"
                  onClick={() => { setDockPanel(null); importInputRef.current?.click(); }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-4-4 4 4 4-4M5 18h14" /></svg>
                </button>
                <button
                  type="button"
                  disabled
                  aria-label="Export canvas, coming soon"
                  title="Export canvas (coming soon)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m-4 4 4-4 4 4M5 18h14" /></svg>
                </button>
                <button
                  className="danger-option"
                  type="button"
                  aria-label="Clear canvas"
                  title="Clear canvas (undoable)"
                  onClick={() => {
                    dispatch({ type: "clear" });
                    setDockPanel(null);
                    setActivity("You cleared the canvas.");
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></svg>
                </button>
              </div>
            </section>
          ) : null}

          <div className="toolbar" role="toolbar" aria-label="Drawing tools">
            <button className={tool === "select" ? "dock-button dock-button--active" : "dock-button"} type="button" aria-label="Select" aria-pressed={tool === "select"} aria-keyshortcuts="M" title="Select (M)" onClick={() => { setTool("select"); setDockPanel(null); }}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v16l4.2-4.2 3.1 5.2 3-1.8-3.1-5.1H19z" /></svg>
            </button>
            <button className={tool === "pan" ? "dock-button dock-button--active" : "dock-button"} type="button" aria-label="Hand tool" aria-pressed={tool === "pan"} aria-keyshortcuts="H" title="Hand (H)" onClick={() => { setTool("pan"); setDockPanel(null); }}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 10V5.5a1.5 1.5 0 0 1 3 0V9M9 5V3.5a1.5 1.5 0 0 1 3 0V9M12 5a1.5 1.5 0 0 1 3 0v5M15 7.5a1.5 1.5 0 0 1 3 0V12c0 4-2.5 6-6.5 6H10c-2 0-3-1-4-2.5L2.5 11A1.6 1.6 0 0 1 5 9z" /></svg>
            </button>
            <span className="dock-divider" aria-hidden="true" />
            <button className={tool === "paint" ? "dock-button dock-button--active" : "dock-button"} type="button" aria-label="Draw" aria-pressed={tool === "paint"} aria-keyshortcuts="B" title="Draw (B)" onClick={() => { setTool("paint"); setDockPanel(null); }}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 14 1.2-4.2L13 2l5 5-7.8 7.8L6 16zM12 3l5 5M4 14l2 2" /></svg>
            </button>
            <button className={tool === "erase" ? "dock-button dock-button--active" : "dock-button"} type="button" aria-label="Erase" aria-pressed={tool === "erase"} aria-keyshortcuts="E" title="Erase (E)" onClick={() => { setTool("erase"); setDockPanel(null); }}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3.5 14 9.5-9.5 7 7-7.5 7.5H8.5zM8 9.5l7 7M12.5 19H21" /></svg>
            </button>
            <button className={tool === "fill" ? "dock-button dock-button--active" : "dock-button"} type="button" aria-label="Fill" aria-pressed={tool === "fill"} aria-keyshortcuts="G" title="Fill (G)" onClick={() => { setTool("fill"); setDockPanel(null); }}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 6-7 6 6-7 7zM7 6l6 6M15 14c0-1 1.5-3 1.5-3s1.5 2 1.5 3a1.5 1.5 0 0 1-3 0" /></svg>
            </button>
            <button className={isShapeTool(tool) || dockPanel === "shape" ? "dock-button dock-button--active" : "dock-button"} type="button" aria-label="Shapes" aria-pressed={isShapeTool(tool)} aria-expanded={dockPanel === "shape"} title="Shapes (L/R/O)" onClick={() => { if (!isShapeTool(tool)) setTool("line"); setDockPanel((current) => current === "shape" ? null : "shape"); }}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3.5" width="8" height="8" /><circle cx="14" cy="13" r="4" /></svg>
            </button>
            <button
              className={dockPanel === "color" || tool === "picker" ? "dock-button dock-button--active color-dock-button" : "dock-button color-dock-button"}
              type="button"
              aria-label="Colors"
              aria-expanded={dockPanel === "color"}
              title="Colors"
              onClick={() => setDockPanel((current) => current === "color" ? null : "color")}
            >
              <span style={{ backgroundColor: selectedColor }} />
            </button>
            <span className="dock-divider" aria-hidden="true" />
            <button className={symmetryEnabled && symmetry.horizontal ? "dock-button dock-button--active" : "dock-button"} type="button" disabled={!symmetryEnabled} aria-label="Mirror horizontally" aria-pressed={symmetry.horizontal} title={symmetryEnabled ? "Mirror across horizontal axis" : "Mirror is available with drawing tools"} onClick={() => { setSymmetry((current) => ({ ...current, horizontal: !current.horizontal })); setDockPanel(null); }}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M7 8l5-5 5 5M7 16l5 5 5-5" /></svg>
            </button>
            <button className={symmetryEnabled && symmetry.vertical ? "dock-button dock-button--active" : "dock-button"} type="button" disabled={!symmetryEnabled} aria-label="Mirror vertically" aria-pressed={symmetry.vertical} title={symmetryEnabled ? "Mirror across vertical axis" : "Mirror is available with drawing tools"} onClick={() => { setSymmetry((current) => ({ ...current, vertical: !current.vertical })); setDockPanel(null); }}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M8 7l-5 5 5 5M16 7l5 5-5 5" /></svg>
            </button>
            <span className="dock-divider" aria-hidden="true" />
            <button className={dockPanel === "more" ? "dock-button dock-button--active" : "dock-button"} type="button" aria-label="More controls" aria-expanded={dockPanel === "more"} title="More" onClick={() => setDockPanel((current) => current === "more" ? null : "more")}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1" /><circle cx="10" cy="10" r="1" /><circle cx="16" cy="10" r="1" /></svg>
            </button>
          </div>
        </div>

        <div className={`utility-dock history-dock${selection ? " utility-dock--selection" : ""}`} role="toolbar" aria-label="History controls" onPointerDown={() => { setCanvasMenu(null); setDockPanel(null); }}>
          <button type="button" disabled={history.undoDepth === 0} onClick={undoPixels} aria-label="Undo" title="Undo (Ctrl/Cmd+Z)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5-4 4 4 4M4 9h6a6 6 0 0 1 6 6" /></svg></button>
          <button type="button" disabled={history.redoDepth === 0} onClick={redoPixels} aria-label="Redo" title="Redo"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5 4 4-4 4m4-4h-6a6 6 0 0 0-6 6" /></svg></button>
        </div>
        <div className={`utility-dock view-dock${selection ? " utility-dock--selection" : ""}`} role="toolbar" aria-label="View controls" onPointerDown={() => { setCanvasMenu(null); setDockPanel(null); }}>
          <button type="button" onClick={() => zoomTo(viewport.zoom / 1.2)} aria-label="Zoom out" title="Zoom out"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10h10" /></svg></button>
          <button type="button" onClick={() => zoomTo(viewport.zoom * 1.2)} aria-label="Zoom in" title="Zoom in"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10h10M10 5v10" /></svg></button>
          <span aria-hidden="true" />
          <button type="button" onClick={() => setViewport({ x: 0, y: 0, zoom: DEFAULT_ZOOM })} aria-label="Center view" title="Center view"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4" /><path d="M10 2v3M10 15v3M2 10h3M15 10h3" /></svg></button>
        </div>

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

        <div
          className={`canvas-column${showExport || showImport ? " canvas-column--exporting" : ""}${isDropTarget ? " canvas-column--dropping" : ""}`}
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
            if (file) void readImportFile(file);
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
                aria-label="Selection actions"
              >
                <button type="button" onClick={clearSelection} aria-label="Clear selected pixels" title="Clear selected pixels">
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
                  onClick={openExportPanel}
                  aria-label="Export selection"
                  title="Export selection"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 2v8m-3-3 3 3 3-3M3 11v2.5h10V11" />
                  </svg>
                </button>
                <span className="selection-action-separator" aria-hidden="true" />
                <button type="button" onClick={dismissSelection} aria-label="Dismiss selection" title="Dismiss selection">
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
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
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
                const nextIndex = event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : event.key === "ArrowDown"
                      ? (currentIndex + 1) % buttons.length
                      : (currentIndex - 1 + buttons.length) % buttons.length;
                buttons[nextIndex]?.focus();
              }}
            >
              <button type="button" role="menuitem" disabled={!copiedSelection} onClick={() => { pasteSelection(); setCanvasMenu(null); }}>Paste here</button>
              {selection ? <button type="button" role="menuitem" onClick={() => { copySelection(); setCanvasMenu(null); }}>Copy selection</button> : null}
              {selection ? <button type="button" role="menuitem" onClick={() => { clearSelection(); setCanvasMenu(null); }}>Delete selection</button> : null}
              <span aria-hidden="true" />
              <button type="button" role="menuitem" disabled={history.undoDepth === 0} onClick={() => { undoPixels(); setCanvasMenu(null); }}>Undo</button>
              <button type="button" role="menuitem" disabled={history.redoDepth === 0} onClick={() => { redoPixels(); setCanvasMenu(null); }}>Redo</button>
              <span aria-hidden="true" />
              <button type="button" role="menuitem" onClick={() => { setCanvasMenu(null); importInputRef.current?.click(); }}>Import image</button>
              <button type="button" role="menuitem" onClick={() => { setViewport({ x: 0, y: 0, zoom: DEFAULT_ZOOM }); setCanvasMenu(null); }}>Center view</button>
            </div>
          ) : null}
          {showExport && selectionSize ? (
            <div
              className="export-layer"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) closeExportPanel();
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
                  if (event.key === "Escape") closeExportPanel();
                }}
              >
                <header>
                  <div>
                    <span>PNG export</span>
                    <h2 id="export-title">Export selection</h2>
                  </div>
                  <button type="button" onClick={closeExportPanel} aria-label="Cancel export">×</button>
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
                          const scale = Math.min(maxExportScale, Math.max(1, Math.round(event.target.valueAsNumber) || 1));
                          setExportScale(scale);
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
                        onChange={(event) => updateExportWidth(event.target.valueAsNumber)}
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
                        onChange={(event) => updateExportHeight(event.target.valueAsNumber)}
                      />
                    </label>
                    <label className="export-ratio-lock">
                      <input
                        type="checkbox"
                        checked={lockExportRatio}
                        onChange={(event) => updateExportRatioLock(event.target.checked)}
                      />
                      Lock ratio
                    </label>
                  </div>
                )}

                <div className="export-summary">
                  <span>Selection {selectionSize.width} × {selectionSize.height}px</span>
                  <strong>{exportOutputSize.width} × {exportOutputSize.height}px</strong>
                </div>
                {exportSizeError || exportError ? <p className="export-error">{exportSizeError || exportError}</p> : null}

                <footer>
                  <button type="button" onClick={closeExportPanel}>Cancel</button>
                  <button
                    className="export-download"
                    type="button"
                    disabled={Boolean(exportSizeError) || isExporting}
                    onClick={() => void exportSelectionAsPng()}
                  >
                    {isExporting ? "Exporting..." : "Download PNG"}
                  </button>
                </footer>
              </section>
            </div>
          ) : null}
          {showImport ? (
            <div
              className="export-layer"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) closeImportPanel();
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
                  if (event.key === "Escape") closeImportPanel();
                }}
              >
                <header>
                  <div>
                    <span>Image import</span>
                    <h2 id="import-title">Place image</h2>
                  </div>
                  <button type="button" onClick={closeImportPanel} aria-label="Cancel import">×</button>
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
                          onChange={(event) => updateImportWidth(event.target.valueAsNumber)}
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
                          onChange={(event) => updateImportHeight(event.target.valueAsNumber)}
                        />
                      </label>
                      <label className="export-ratio-lock">
                        <input
                          type="checkbox"
                          checked={lockImportRatio}
                          onChange={(event) => updateImportRatioLock(event.target.checked)}
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
                        {selection ? "Top-left of the selection" : "Centered on the view"} at ({importOrigin.x}, {importOrigin.y})
                      </span>
                      <strong>{importDimensions.width} × {importDimensions.height}px</strong>
                    </div>
                  </>
                ) : (
                  <p className="import-note">
                    <span>{isReadingImport ? "Reading the image…" : "No image loaded."}</span>
                  </p>
                )}

                {importSizeError || importError ? <p className="export-error">{importSizeError || importError}</p> : null}

                <footer>
                  <button type="button" onClick={closeImportPanel}>Cancel</button>
                  <button
                    className="export-download"
                    type="button"
                    disabled={!importSource || Boolean(importSizeError) || isReadingImport}
                    onClick={placeImportedImage}
                  >
                    Place pixels
                  </button>
                </footer>
              </section>
            </div>
          ) : null}
          <footer className="canvas-meta">
            <span>{Math.round(viewport.x)}, {Math.round(viewport.y)}</span>
            <span className="sr-only" aria-live="polite">{storageError || activity}</span>
          </footer>
        </div>
      </section>
    </main>
  );
}

export default App;
