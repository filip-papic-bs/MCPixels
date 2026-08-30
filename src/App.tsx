import { useEffect, useReducer, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

const EMPTY_PIXEL = "transparent";
const MIN_ZOOM = 4;
const MAX_ZOOM = 48;
const DEFAULT_ZOOM = 22;
const DRAG_THRESHOLD = 5;
const MAX_TOOL_COORDINATE = 1_000_000;
const STORAGE_KEY = "mcpixels.editor.v1";
const SELECTION_ACTIONS_WIDTH = 273;
const SELECTION_ACTIONS_WITH_PASTE_WIDTH = 306;
const SELECTION_ACTIONS_HEIGHT = 32;
const SELECTION_ACTIONS_GAP = 8;
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
const MAX_FILL_PIXELS = 50_000;
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
  | { type: "move"; from: SelectionBounds; changes: PixelChange[] }
  | { type: "clear" }
  | { type: "undo" }
  | { type: "redo" };
type PixelHistory = {
  pixels: Map<string, string>;
  undoStack: Map<string, string>[];
  redoStack: Map<string, string>[];
  historyGroup: number | null;
};
type Viewport = { x: number; y: number; zoom: number };
type SelectionBounds = { minX: number; minY: number; maxX: number; maxY: number };
type CopiedSelection = { pixels: PixelChange[]; width: number; height: number };
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
  reason?: "same-color" | "open-area" | "too-large";
};
type PersistedEditorState = {
  pixels: Map<string, string>;
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

const pixelKey = (x: number, y: number) => `${x},${y}`;

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

function isColorTool(tool: Tool): tool is ColorTool {
  return tool === "paint" || tool === "fill" || tool === "line" || tool === "rectangle" || tool === "ellipse";
}

function isShapeTool(tool: Tool): tool is ShapeTool {
  return tool === "line" || tool === "rectangle" || tool === "ellipse";
}

function pixelReducer(state: PixelHistory, action: PixelAction): PixelHistory {
  if (action.type === "undo") {
    const pixels = state.undoStack.at(-1);
    if (!pixels) return state;
    return {
      pixels,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, state.pixels].slice(-HISTORY_LIMIT),
      historyGroup: null,
    };
  }

  if (action.type === "redo") {
    const pixels = state.redoStack.at(-1);
    if (!pixels) return state;
    return {
      pixels,
      undoStack: [...state.undoStack, state.pixels].slice(-HISTORY_LIMIT),
      redoStack: state.redoStack.slice(0, -1),
      historyGroup: null,
    };
  }

  let next: Map<string, string>;
  let changed = false;
  if (action.type === "clear") {
    if (state.pixels.size === 0) return state;
    next = new Map<string, string>();
    changed = true;
  } else if (action.type === "clear-area") {
    next = new Map(state.pixels);
    for (const key of state.pixels.keys()) {
      const [x, y] = key.split(",").map(Number);
      if (x >= action.bounds.minX && x <= action.bounds.maxX && y >= action.bounds.minY && y <= action.bounds.maxY) {
        next.delete(key);
        changed = true;
      }
    }
  } else if (action.type === "move") {
    next = new Map(state.pixels);
    for (const key of state.pixels.keys()) {
      const [x, y] = key.split(",").map(Number);
      if (x >= action.from.minX && x <= action.from.maxX && y >= action.from.minY && y <= action.from.maxY) {
        next.delete(key);
        changed = true;
      }
    }
    for (const { x, y, color } of action.changes) {
      const key = pixelKey(x, y);
      if (color === EMPTY_PIXEL) {
        if (next.delete(key)) changed = true;
      } else if (next.get(key) !== color) {
        next.set(key, color);
        changed = true;
      }
    }
  } else {
    next = new Map(state.pixels);
    for (const { x, y, color } of action.changes) {
      const key = pixelKey(x, y);
      if (color === EMPTY_PIXEL) {
        if (next.delete(key)) changed = true;
      } else if (next.get(key) !== color) {
        next.set(key, color);
        changed = true;
      }
    }
  }

  if (!changed) return state;
  const historyGroup = action.type === "paint" ? action.historyGroup ?? null : null;
  const continuesHistoryGroup = historyGroup !== null && historyGroup === state.historyGroup;
  return {
    pixels: next,
    undoStack: continuesHistoryGroup
      ? state.undoStack
      : [...state.undoStack, state.pixels].slice(-HISTORY_LIMIT),
    redoStack: [],
    historyGroup,
  };
}

function isCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && Math.abs(Number(value)) <= MAX_TOOL_COORDINATE;
}

function clampZoom(zoom: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function selectionBounds(from: { x: number; y: number }, to: { x: number; y: number }): SelectionBounds {
  return {
    minX: Math.min(from.x, to.x),
    minY: Math.min(from.y, to.y),
    maxX: Math.max(from.x, to.x),
    maxY: Math.max(from.y, to.y),
  };
}

function floodFill(pixels: Map<string, string>, start: ScreenPoint, color: string): FillResult {
  const targetColor = pixels.get(pixelKey(start.x, start.y)) ?? EMPTY_PIXEL;
  if (targetColor === color) return { changes: [], reason: "same-color" };

  const queue = [start];
  const visited = new Set([pixelKey(start.x, start.y)]);
  const changes: PixelChange[] = [];
  let queueIndex = 0;
  let bounds: SelectionBounds | null = null;

  if (targetColor === EMPTY_PIXEL) {
    if (pixels.size === 0) return { changes: [], reason: "open-area" };
    for (const key of pixels.keys()) {
      const [x, y] = key.split(",").map(Number);
      if (!bounds) bounds = { minX: x, minY: y, maxX: x, maxY: y };
      else {
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
    }
    if (!bounds || start.x < bounds.minX || start.x > bounds.maxX || start.y < bounds.minY || start.y > bounds.maxY) {
      return { changes: [], reason: "open-area" };
    }
  }

  while (queueIndex < queue.length) {
    const point = queue[queueIndex];
    queueIndex += 1;
    if (
      targetColor === EMPTY_PIXEL &&
      bounds &&
      (point.x <= bounds.minX - 1 || point.x >= bounds.maxX + 1 || point.y <= bounds.minY - 1 || point.y >= bounds.maxY + 1)
    ) {
      return { changes: [], reason: "open-area" };
    }

    changes.push({ ...point, color });
    if (changes.length > MAX_FILL_PIXELS) return { changes: [], reason: "too-large" };

    const neighbors = [
      { x: point.x - 1, y: point.y },
      { x: point.x + 1, y: point.y },
      { x: point.x, y: point.y - 1 },
      { x: point.x, y: point.y + 1 },
    ];
    for (const neighbor of neighbors) {
      const key = pixelKey(neighbor.x, neighbor.y);
      if (visited.has(key)) continue;
      const neighborColor = pixels.get(key) ?? EMPTY_PIXEL;
      if (neighborColor !== targetColor) continue;
      visited.add(key);
      queue.push(neighbor);
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

function loadPersistedState(): PersistedEditorState {
  const fallback: PersistedEditorState = {
    pixels: new Map<string, string>(),
    viewport: { x: 0, y: 0, zoom: DEFAULT_ZOOM },
    selectedColor: PALETTE[0],
    customColors: [],
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    if (saved.version !== 1 || !Array.isArray(saved.pixels)) return fallback;

    const pixels = new Map<string, string>();
    for (const entry of saved.pixels) {
      if (!Array.isArray(entry) || entry.length !== 3) continue;
      const [x, y, color] = entry as unknown[];
      if (isCoordinate(x) && isCoordinate(y) && typeof color === "string" && COLOR_PATTERN.test(color)) {
        pixels.set(pixelKey(x, y), color.toLowerCase());
      }
    }

    const savedViewport = saved.viewport as Record<string, unknown> | undefined;
    const viewport =
      savedViewport &&
      typeof savedViewport.x === "number" &&
      Number.isFinite(savedViewport.x) &&
      typeof savedViewport.y === "number" &&
      Number.isFinite(savedViewport.y) &&
      typeof savedViewport.zoom === "number" &&
      Number.isFinite(savedViewport.zoom)
        ? { x: savedViewport.x, y: savedViewport.y, zoom: clampZoom(savedViewport.zoom) }
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

    return { pixels, viewport, selectedColor, customColors };
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
        mirrored.set(pixelKey(x, y), { x, y, color: change.color });
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
    Math.max(-MAX_TOOL_COORDINATE, Math.min(MAX_TOOL_COORDINATE - size + 1, value));
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

function App() {
  const [initialState] = useState(loadPersistedState);
  const [pixelHistory, dispatch] = useReducer(pixelReducer, {
    pixels: initialState.pixels,
    undoStack: [],
    redoStack: [],
    historyGroup: null,
  });
  const pixels = pixelHistory.pixels;
  const [selectedColor, setSelectedColor] = useState(initialState.selectedColor);
  const [customColors, setCustomColors] = useState(initialState.customColors);
  const [tool, setTool] = useState<Tool>("paint");
  const [shapeStyle, setShapeStyle] = useState<ShapeStyle>("outline");
  const [symmetry, setSymmetry] = useState<Symmetry>({ horizontal: false, vertical: false });
  const [shapePreview, setShapePreview] = useState<PixelChange[]>([]);
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const pixelsRef = useRef(pixels);
  const viewportRef = useRef(viewport);
  const pointerRef = useRef<PointerState>(null);
  const historyGroupRef = useRef(0);
  const toolBeforePickerRef = useRef<ColorTool>("paint");
  const touchPointsRef = useRef(new Map<number, ScreenPoint>());
  const shapePreviewFrameRef = useRef<number | null>(null);
  const spacePressedRef = useRef(false);
  const suppressContextMenuRef = useRef(false);
  pixelsRef.current = pixels;
  viewportRef.current = viewport;

  useEffect(() => {
    const save = () => {
      try {
        const savedPixels = Array.from(pixels, ([key, color]) => {
          const [x, y] = key.split(",").map(Number);
          return [x, y, color] as const;
        });
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ version: 1, pixels: savedPixels, viewport, selectedColor, customColors }),
        );
      } catch (error) {
        console.warn("Could not save the MCPixels canvas", error);
      }
    };

    const timeout = window.setTimeout(save, 200);
    window.addEventListener("pagehide", save);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pagehide", save);
    };
  }, [customColors, pixels, selectedColor, viewport]);

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
    const panelOpen = showExport || showImport;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select") || target?.isContentEditable;
      const modifierPressed = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const wantsUndo = modifierPressed && key === "z" && !event.shiftKey;
      const wantsRedo = modifierPressed && ((key === "z" && event.shiftKey) || key === "y");

      if (!panelOpen && !isTyping && wantsUndo && pixelHistory.undoStack.length > 0) {
        event.preventDefault();
        dispatch({ type: "undo" });
        setActivity("Undid the last pixel edit.");
        return;
      }
      if (!panelOpen && !isTyping && wantsRedo && pixelHistory.redoStack.length > 0) {
        event.preventDefault();
        dispatch({ type: "redo" });
        setActivity("Redid the last pixel edit.");
        return;
      }
      const shortcutTool = !modifierPressed && !event.altKey ? TOOL_SHORTCUTS[key] : undefined;
      if (!panelOpen && !isTyping && !event.repeat && shortcutTool) {
        event.preventDefault();
        if (shortcutTool === "picker" && tool !== "picker") {
          toolBeforePickerRef.current = isColorTool(tool) ? tool : "paint";
        }
        setTool(shortcutTool);
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
  }, [pixelHistory.redoStack.length, pixelHistory.undoStack.length, showExport, showImport, tool]);

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

    const { x: centerX, y: centerY, zoom } = viewport;
    const minX = Math.floor(centerX - width / (2 * zoom)) - 1;
    const maxX = Math.ceil(centerX + width / (2 * zoom)) + 1;
    const minY = Math.floor(centerY - height / (2 * zoom)) - 1;
    const maxY = Math.ceil(centerY + height / (2 * zoom)) + 1;
    const screenX = (x: number) => (x - centerX) * zoom + width / 2;
    const screenY = (y: number) => (y - centerY) * zoom + height / 2;

    context.imageSmoothingEnabled = false;
    context.fillStyle = "#fafaf7";
    context.fillRect(0, 0, width, height);

    const movingFrom = movingSelection?.originalBounds ?? null;
    for (const [key, color] of pixels) {
      const [x, y] = key.split(",").map(Number);
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (
        movingFrom &&
        x >= movingFrom.minX &&
        x <= movingFrom.maxX &&
        y >= movingFrom.minY &&
        y <= movingFrom.maxY
      ) {
        continue;
      }
      context.fillStyle = color;
      context.fillRect(screenX(x), screenY(y), zoom, zoom);
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

    context.beginPath();
    context.strokeStyle = "#d5d7d2";
    context.lineWidth = 1;
    for (let x = minX; x <= maxX + 1; x += 1) {
      const position = Math.round(screenX(x)) + 0.5;
      context.moveTo(position, 0);
      context.lineTo(position, height);
    }
    for (let y = minY; y <= maxY + 1; y += 1) {
      const position = Math.round(screenY(y)) + 0.5;
      context.moveTo(0, position);
      context.lineTo(width, position);
    }
    context.stroke();

    context.lineWidth = 1;
    context.beginPath();
    context.strokeStyle = symmetry.vertical ? "#ef5938" : "#aeb2ac";
    context.moveTo(screenX(0), 0);
    context.lineTo(screenX(0), height);
    context.stroke();
    context.beginPath();
    context.strokeStyle = symmetry.horizontal ? "#ef5938" : "#aeb2ac";
    context.moveTo(0, screenY(0));
    context.lineTo(width, screenY(0));
    context.stroke();
  }, [canvasSize, movingSelection, pixels, selection, shapePreview, symmetry, viewport]);

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

  const startDrawingAt = (clientX: number, clientY: number, pointerId: number) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel) return;
    const color = tool === "erase" ? EMPTY_PIXEL : selectedColor;
    const changes = applySymmetry([{ ...pixel, color }], symmetry);
    if (!changes) return;
    historyGroupRef.current += 1;
    const historyGroup = historyGroupRef.current;
    pointerRef.current = { kind: "draw", pointerId, lastPixel: pixel, historyGroup, color, symmetry };
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
    const result = floodFill(pixelsRef.current, pixel, selectedColor);
    if (result.changes.length > 0) {
      dispatch({ type: "paint", changes: result.changes });
      setActivity(`Filled ${result.changes.length} pixel${result.changes.length === 1 ? "" : "s"}.`);
      return;
    }
    if (result.reason === "open-area") setActivity("Open empty space cannot be filled on the infinite canvas.");
    else if (result.reason === "too-large") setActivity(`Fill stopped because it exceeded ${MAX_FILL_PIXELS} pixels.`);
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
    const color = pixelsRef.current.get(pixelKey(pixel.x, pixel.y));
    if (!color) {
      setActivity("There is no color at that pixel to pick.");
      return;
    }
    selectEditorColor(color);
    setTool(toolBeforePickerRef.current);
    setActivity(`Picked ${color} from pixel (${pixel.x}, ${pixel.y}).`);
  };

  const startSelectionAt = (clientX: number, clientY: number, pointerId: number) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel) return;
    pointerRef.current = { kind: "select", pointerId, anchor: pixel };
    setSelection(selectionBounds(pixel, pixel));
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

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current && !(event.pointerType === "touch" && tool === "pan")) return;
    const shouldPan =
      event.button === 1 ||
      event.button === 2 ||
      tool === "pan" ||
      (event.button === 0 && spacePressedRef.current);
    const shouldFill = event.button === 0 && !shouldPan && tool === "fill";
    const shouldPickColor = event.button === 0 && !shouldPan && tool === "picker";
    const shouldSelect = event.button === 0 && !shouldPan && tool === "select";
    const shouldDraw = event.button === 0 && !shouldPan && (tool === "paint" || tool === "erase");
    const shouldShape = event.button === 0 && !shouldPan && isShapeTool(tool);
    if (!shouldPan && !shouldDraw && !shouldFill && !shouldPickColor && !shouldSelect && !shouldShape) return;

    if (event.button !== 2) event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    if (event.pointerType === "touch" && tool === "pan") {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const pinch = getPinchMetrics(touchPointsRef.current);
      if (pinch) {
        pointerRef.current = {
          kind: "pinch",
          lastCenter: pinch.center,
          lastDistance: pinch.distance,
        };
        setIsPanning(true);
        return;
      }
    }

    if (shouldSelect) {
      const pixel = getPixelAt(event.clientX, event.clientY);
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
      fillAt(event.clientX, event.clientY);
      return;
    }
    if (shouldPickColor) {
      pickColorAt(event.clientX, event.clientY);
      return;
    }
    if (shouldDraw) {
      startDrawingAt(event.clientX, event.clientY, event.pointerId);
      return;
    }

    if (event.button === 2) suppressContextMenuRef.current = false;
    pointerRef.current = {
      kind: "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      hasDragged: false,
      button: event.button,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
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
        const zoom = clampZoom(current.zoom * (pinch.distance / pointer.lastDistance));
        const worldX = current.x + (previousAnchor.x - canvasSize.width / 2) / current.zoom;
        const worldY = current.y + (previousAnchor.y - canvasSize.height / 2) / current.zoom;
        return {
          x: worldX - (nextAnchor.x - canvasSize.width / 2) / zoom,
          y: worldY - (nextAnchor.y - canvasSize.height / 2) / zoom,
          zoom,
        };
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

    if (pointer.kind === "shape") {
      continueShapeAt(event.clientX, event.clientY, pointer);
      return;
    }

    if (pointer.kind === "select") {
      const pixel = getPixelAt(event.clientX, event.clientY);
      if (pixel) setSelection(selectionBounds(pointer.anchor, pixel));
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
    if (!pointer.hasDragged) setIsPanning(true);
    if (pointer.button === 2) suppressContextMenuRef.current = true;
    setViewport((current) => ({
      ...current,
      x: current.x - deltaX / current.zoom,
      y: current.y - deltaY / current.zoom,
    }));
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>, cancelled = false) => {
    const activePointer = pointerRef.current;
    if (activePointer && "pointerId" in activePointer && activePointer.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    touchPointsRef.current.delete(event.pointerId);
    if (cancelled) {
      setShapePreview([]);
      setMovingSelection(null);
      pointerRef.current = null;
      setIsPanning(false);
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
        const bounds = selectionBounds(pointerRef.current.anchor, pixel);
        setSelection(bounds);
        const width = bounds.maxX - bounds.minX + 1;
        const height = bounds.maxY - bounds.minY + 1;
        setActivity(`Selected ${width} by ${height} pixels.`);
      }
    }
    if (pointerRef.current?.kind === "move-selection" && movingSelection) {
      const pointer = pointerRef.current;
      const pixel = getPixelAt(event.clientX, event.clientY);
      const dx = pixel ? pixel.x - pointer.anchor.x : 0;
      const dy = pixel ? pixel.y - pointer.anchor.y : 0;
      const { originalBounds, captured } = movingSelection;
      if (dx !== 0 || dy !== 0) {
        const changes = captured.pixels.map(({ x, y, color }) => ({
          x: originalBounds.minX + x + dx,
          y: originalBounds.minY + y + dy,
          color,
        }));
        dispatch({ type: "move", from: originalBounds, changes });
        setActivity(`Moved a ${captured.width} by ${captured.height} selection.`);
      }
      setMovingSelection(null);
    }
    pointerRef.current = null;
    setIsPanning(false);
  };

  const zoomTo = (nextZoom: number, point?: { x: number; y: number }) => {
    setViewport((current) => {
      const zoom = clampZoom(nextZoom);
      if (zoom === current.zoom) return current;
      const anchor = point ?? { x: canvasSize.width / 2, y: canvasSize.height / 2 };
      const worldX = current.x + (anchor.x - canvasSize.width / 2) / current.zoom;
      const worldY = current.y + (anchor.y - canvasSize.height / 2) / current.zoom;
      return {
        x: worldX - (anchor.x - canvasSize.width / 2) / zoom,
        y: worldY - (anchor.y - canvasSize.height / 2) / zoom,
        zoom,
      };
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = canvas.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setViewport((current) => {
        const zoom = clampZoom(current.zoom * factor);
        if (zoom === current.zoom) return current;
        const worldX = current.x + (anchor.x - canvasSize.width / 2) / current.zoom;
        const worldY = current.y + (anchor.y - canvasSize.height / 2) / current.zoom;
        return {
          x: worldX - (anchor.x - canvasSize.width / 2) / zoom,
          y: worldY - (anchor.y - canvasSize.height / 2) / zoom,
          zoom,
        };
      });
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
      x: { type: "integer", minimum: -MAX_TOOL_COORDINATE, maximum: MAX_TOOL_COORDINATE },
      y: { type: "integer", minimum: -MAX_TOOL_COORDINATE, maximum: MAX_TOOL_COORDINATE },
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
            description: "Read every colored pixel on the unbounded canvas and the current visible viewport. Coordinates may be negative or positive.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
            execute: async () => ({
              canvas: "unbounded",
              viewport: viewportRef.current,
              coloredPixels: Array.from(pixelsRef.current, ([key, color]) => {
                const [x, y] = key.split(",").map(Number);
                return { x, y, color };
              }),
            }),
          },
          { signal: controller.signal },
        ),
        modelContext.registerTool(
          {
            name: "paint_pixels",
            title: "Paint pixels",
            description: "Paint pixels anywhere on the unbounded canvas. Coordinates may be negative or positive; colors must be six-digit hex values.",
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
                  throw new Error(`Invalid pixel: ${JSON.stringify(pixel)}`);
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
            description: "Erase pixels at negative or positive coordinates on the unbounded canvas.",
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
                if (!isCoordinate(x) || !isCoordinate(y)) throw new Error(`Invalid pixel: ${JSON.stringify(pixel)}`);
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
            description: `Center the visible canvas on a coordinate and set its zoom from ${MIN_ZOOM} to ${MAX_ZOOM} pixels per cell.`,
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
                throw new Error("Invalid canvas view");
              }
              setViewport({ x, y, zoom });
              setActivity(`Agent centered the view at (${x}, ${y}).`);
              return { success: true, viewport: { x, y, zoom } };
            },
          },
          { signal: controller.signal },
        ),
        modelContext.registerTool(
          {
            name: "clear_sprite",
            title: "Clear sprite",
            description: "Erase every colored pixel from the unbounded canvas.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => {
              const cleared = pixelsRef.current.size;
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
  const selectionActionsWidth = copiedSelection ? SELECTION_ACTIONS_WITH_PASTE_WIDTH : SELECTION_ACTIONS_WIDTH;
  const selectionActionsStyle = selectionScreen
    ? {
        left: Math.min(
          Math.max(SELECTION_ACTIONS_GAP, selectionScreen.left + selectionScreen.width - selectionActionsWidth),
          Math.max(SELECTION_ACTIONS_GAP, canvasSize.width - selectionActionsWidth - SELECTION_ACTIONS_GAP),
        ),
        top: Math.min(
          Math.max(
            SELECTION_ACTIONS_GAP,
            selectionScreen.top >= SELECTION_ACTIONS_HEIGHT + SELECTION_ACTIONS_GAP * 2
              ? selectionScreen.top - SELECTION_ACTIONS_HEIGHT - SELECTION_ACTIONS_GAP
              : selectionScreen.top + selectionScreen.height + SELECTION_ACTIONS_GAP,
          ),
          Math.max(SELECTION_ACTIONS_GAP, canvasSize.height - SELECTION_ACTIONS_HEIGHT - SELECTION_ACTIONS_GAP),
        ),
      }
    : null;

  const clearSelection = () => {
    if (!selection) return;
    let cleared = 0;
    for (const key of pixelsRef.current.keys()) {
      const [x, y] = key.split(",").map(Number);
      if (x >= selection.minX && x <= selection.maxX && y >= selection.minY && y <= selection.maxY) {
        cleared += 1;
      }
    }
    dispatch({ type: "clear-area", bounds: selection });
    setSelection(null);
    setActivity(`Cleared ${cleared} pixel${cleared === 1 ? "" : "s"} from the selection.`);
  };

  const captureSelection = () => {
    if (!selection) return null;
    const copiedPixels: PixelChange[] = [];
    for (const [key, color] of pixelsRef.current) {
      const [x, y] = key.split(",").map(Number);
      if (x >= selection.minX && x <= selection.maxX && y >= selection.minY && y <= selection.maxY) {
        copiedPixels.push({ x: x - selection.minX, y: y - selection.minY, color });
      }
    }
    const width = selection.maxX - selection.minX + 1;
    const height = selection.maxY - selection.minY + 1;
    return { pixels: copiedPixels, width, height };
  };

  const copySelection = () => {
    const copied = captureSelection();
    if (!copied) return;
    setCopiedSelection(copied);
    setSelection(null);
    setActivity(`Copied ${copied.pixels.length} pixel${copied.pixels.length === 1 ? "" : "s"} from a ${copied.width} by ${copied.height} selection.`);
  };

  const cutSelection = () => {
    if (!selection) return;
    const copied = captureSelection();
    if (!copied) return;
    setCopiedSelection(copied);
    dispatch({ type: "clear-area", bounds: selection });
    setSelection(null);
    setActivity(`Cut ${copied.pixels.length} pixel${copied.pixels.length === 1 ? "" : "s"} from a ${copied.width} by ${copied.height} selection.`);
  };

  const pasteSelection = () => {
    if (!selection || !copiedSelection) return;
    const changes = copiedSelection.pixels.map(({ x, y, color }) => ({
      x: selection.minX + x,
      y: selection.minY + y,
      color,
    }));
    if (changes.length > 0) dispatch({ type: "paint", changes });
    setSelection(null);
    setActivity(`Pasted ${changes.length} pixel${changes.length === 1 ? "" : "s"} from a ${copiedSelection.width} by ${copiedSelection.height} copy.`);
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
    dispatch({ type: "move", from: selection, changes });
    setSelection({
      minX: selection.minX,
      minY: selection.minY,
      maxX: selection.minX + nextWidth - 1,
      maxY: selection.minY + nextHeight - 1,
    });
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

      for (const [key, color] of pixelsRef.current) {
        const [x, y] = key.split(",").map(Number);
        if (x < selection.minX || x > selection.maxX || y < selection.minY || y > selection.maxY) continue;
        sourceContext.fillStyle = color;
        sourceContext.fillRect(x - selection.minX, y - selection.minY, 1, 1);
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
      if (!file) return;
      event.preventDefault();
      void readImportFile(file);
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
  }, []);

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
    if (pixelHistory.undoStack.length === 0) return;
    dispatch({ type: "undo" });
    setActivity("Undid the last pixel edit.");
  };

  const redoPixels = () => {
    if (pixelHistory.redoStack.length === 0) return;
    dispatch({ type: "redo" });
    setActivity("Redid the last pixel edit.");
  };

  return (
    <main className="app-shell">
      <header className="masthead">
        <a className="wordmark" href="/" aria-label="MCPixels home">
          <span className="wordmark-mcp">MCP</span><span className="wordmark-tail">ixels</span>
        </a>
        <div className={`agent-status agent-status--${webMcpStatus}`}>
          <span aria-hidden="true" />
          {statusText}
        </div>
      </header>

      <section className="editor" aria-label="MCPixels editor">
        <div className="toolbar" aria-label="Drawing controls">
          <fieldset className="color-control">
            <legend>Color</legend>
            <div className="palette">
              {paletteColors.map((color, index) => (
                <button
                  key={index}
                  className={isColorTool(tool) && selectedColor === color ? "swatch swatch--active" : "swatch"}
                  style={{ backgroundColor: color }}
                  type="button"
                  aria-label={`Use color ${color}`}
                  aria-pressed={isColorTool(tool) && selectedColor === color}
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
                aria-label="Pick a color from the canvas"
                aria-pressed={tool === "picker"}
                aria-keyshortcuts="I"
                title="Pick color (I)"
                onClick={() => {
                  if (tool !== "picker") toolBeforePickerRef.current = isColorTool(tool) ? tool : "paint";
                  setTool("picker");
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m9.5 2.5 4 4-2 2-1-1-5.5 5.5H2.5v-2.5L8 5l-1-1zM4.5 11.5h-2" />
                </svg>
              </button>
            </div>
          </fieldset>

          <fieldset className="mode-control">
            <legend>Tool</legend>
            <div className="segmented-control">
              {(["paint", "erase", "fill", "pan", "select"] as Tool[]).map((mode) => {
                const label = mode === "paint" ? "Draw" : mode === "erase" ? "Erase" : mode === "fill" ? "Fill" : mode === "pan" ? "Pan" : "Select";
                const shortcut = mode === "paint" ? "B" : mode === "erase" ? "E" : mode === "fill" ? "G" : mode === "pan" ? "H" : "M";
                return (
                  <button
                    key={mode}
                    className={tool === mode ? "segment segment--active" : "segment"}
                    type="button"
                    aria-pressed={tool === mode}
                    aria-keyshortcuts={shortcut}
                    title={`${label} (${shortcut})`}
                    onClick={() => setTool(mode)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="shape-control">
            <legend>Shape</legend>
            <div className="segmented-control shape-buttons">
              {(["line", "rectangle", "ellipse"] as ShapeTool[]).map((mode) => {
                const label = mode === "rectangle" ? "Rect" : mode[0].toUpperCase() + mode.slice(1);
                const shortcut = mode === "line" ? "L" : mode === "rectangle" ? "R" : "O";
                return (
                  <button
                    key={mode}
                    className={tool === mode ? "segment segment--active" : "segment"}
                    type="button"
                    aria-pressed={tool === mode}
                    aria-keyshortcuts={shortcut}
                    title={`${mode[0].toUpperCase() + mode.slice(1)} (${shortcut})`}
                    onClick={() => setTool(mode)}
                  >
                    {label}
                  </button>
                );
              })}
              {(["outline", "filled"] as ShapeStyle[]).map((style) => (
                <button
                  key={style}
                  className={shapeStyle === style ? "segment segment--active shape-style" : "segment shape-style"}
                  type="button"
                  aria-pressed={shapeStyle === style}
                  onClick={() => setShapeStyle(style)}
                >
                  {style === "outline" ? "Out" : "Fill"}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="symmetry-control">
            <legend>Mirror</legend>
            <div className="segmented-control">
              <button
                className={symmetry.horizontal ? "segment segment--active" : "segment"}
                type="button"
                aria-pressed={symmetry.horizontal}
                title="Mirror across the horizontal origin axis"
                onClick={() => {
                  setSymmetry((current) => ({ ...current, horizontal: !current.horizontal }));
                  setActivity(`Horizontal mirror ${symmetry.horizontal ? "disabled" : "enabled"}.`);
                }}
              >
                Horizontal
              </button>
              <button
                className={symmetry.vertical ? "segment segment--active" : "segment"}
                type="button"
                aria-pressed={symmetry.vertical}
                title="Mirror across the vertical origin axis"
                onClick={() => {
                  setSymmetry((current) => ({ ...current, vertical: !current.vertical }));
                  setActivity(`Vertical mirror ${symmetry.vertical ? "disabled" : "enabled"}.`);
                }}
              >
                Vertical
              </button>
            </div>
          </fieldset>

          <fieldset className="history-control">
            <legend>History</legend>
            <div className="history-buttons">
              <button
                type="button"
                disabled={pixelHistory.undoStack.length === 0}
                onClick={undoPixels}
                aria-label="Undo last pixel edit"
                title="Undo"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M6 4 2.5 7.5 6 11M3 7.5h5a5 5 0 0 1 5 5" />
                </svg>
              </button>
              <button
                type="button"
                disabled={pixelHistory.redoStack.length === 0}
                onClick={redoPixels}
                aria-label="Redo last pixel edit"
                title="Redo"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m10 4 3.5 3.5L10 11m3-3.5H8a5 5 0 0 0-5 5" />
                </svg>
              </button>
            </div>
          </fieldset>

          <fieldset className="zoom-control">
            <legend>Zoom</legend>
            <div className="zoom-buttons">
              <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomTo(viewport.zoom / 1.2)}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="6.5" cy="6.5" r="4" />
                  <path d="M4.5 6.5h4m1 3 4 4" />
                </svg>
              </button>
              <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomTo(viewport.zoom * 1.2)}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="6.5" cy="6.5" r="4" />
                  <path d="M4.5 6.5h4m-2-2v4m3-1 4 4" />
                </svg>
              </button>
              <button
                className="home-button"
                type="button"
                onClick={() => setViewport({ x: 0, y: 0, zoom: DEFAULT_ZOOM })}
              >
                Center
              </button>
            </div>
          </fieldset>

          <div className="file-actions">
            <button
              className="import-button"
              type="button"
              title="Import an image (drop or paste one too)"
              onClick={() => importInputRef.current?.click()}
            >
              Import
            </button>
            <button
              className="clear-button"
              type="button"
              onClick={() => {
                dispatch({ type: "clear" });
                setActivity("You cleared the canvas.");
              }}
            >
              Clear all
            </button>
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
              void readImportFile(file);
            }}
          />
        </div>

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
            aria-label="Unbounded pixel canvas. Use Draw, Erase, Fill, Line, Rectangle, Ellipse, Pick color, or Select; enable horizontal or vertical mirroring around the origin axes; right-drag or Space-drag to pan, and use the mouse wheel to zoom."
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={(event) => handlePointerEnd(event, true)}
            onKeyDown={handleCanvasKeyDown}
            onContextMenu={(event) => {
              if (suppressContextMenuRef.current) {
                event.preventDefault();
                suppressContextMenuRef.current = false;
              }
            }}
          />
          {selectionScreen && selectionActionsStyle ? (
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
              {movingSelection ? null : (
              <div
                className={`selection-actions${copiedSelection ? " selection-actions--with-paste" : ""}`}
                style={selectionActionsStyle}
                aria-label="Selection actions"
              >
                <button type="button" onClick={clearSelection} aria-label="Clear selected pixels" title="Clear selected pixels">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3.5 4.5h9M6 4.5v-2h4v2m1.5 0-.6 9h-5.8l-.6-9M7 7v4M9 7v4" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={copySelection}
                  aria-label="Copy selected pixels"
                  title="Copy selected pixels"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="5.5" y="5.5" width="7" height="7" />
                    <path d="M3.5 10.5h-1v-8h8v1" />
                  </svg>
                </button>
                <button type="button" onClick={cutSelection} aria-label="Cut selected pixels" title="Cut selected pixels">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="4" cy="4" r="2" />
                    <circle cx="4" cy="12" r="2" />
                    <path d="m5.5 5.5 7 7M5.5 10.5l7-7" />
                  </svg>
                </button>
                {copiedSelection ? (
                  <button type="button" onClick={pasteSelection} aria-label="Paste copied pixels" title="Paste copied pixels">
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M5 4V2.5h6V4m-7 0h8v9H4zM8 6v5m-2-2 2 2 2-2" />
                    </svg>
                  </button>
                ) : null}
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
            <span className="sr-only" aria-live="polite">{activity}</span>
          </footer>
        </div>
      </section>
    </main>
  );
}

export default App;
