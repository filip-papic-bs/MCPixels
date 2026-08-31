export const EMPTY_PIXEL = "transparent";
export const EMPTY_CELL = 0;
export const CANVAS_SIZE = 1024;
export const CANVAS_MIN = -CANVAS_SIZE / 2;
export const CANVAS_MAX = CANVAS_SIZE / 2 - 1;
export const MIN_ZOOM = 0.1;
export const GRID_LINE_ZOOM = 8;
export const MAX_ZOOM = 64;
export const DEFAULT_ZOOM = 22;
export const DRAG_THRESHOLD = 5;
export const STORAGE_KEY = "mcpixels.editor.v1";
export const STORAGE_VERSION = 2;
export const MAX_STORED_BYTES = 1_200_000;
export const DEFAULT_EXPORT_SCALE = 8;
export const MAX_EXPORT_SCALE = 64;
export const MAX_EXPORT_DIMENSION = 4096;
export const MAX_IMPORT_SOURCE_DIMENSION = 4096;
export const MAX_IMPORT_DIMENSION = 256;
export const IMPORT_ALPHA_THRESHOLD = 128;
export const IMPORT_MATCH_TOLERANCE = 16;
export const MIN_IMPORT_CELL_SIZE = 2;
export const IMPORT_EDGE_CELL_BIAS = 0.15;
export const HISTORY_LIMIT = 100;
export const HISTORY_CELL_LIMIT = 2_000_000;
export const MAX_SHAPE_PIXELS = 50_000;
export const MAX_CUSTOM_COLORS = 8;
export const BRUSH_SIZES = [1, 2, 3, 4, 6, 8];
export const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
export const PALETTE = ["#161616", "#f5f1e8", "#ff5c35", "#ffbd2e", "#45b86b", "#2d7ff9", "#7557d3", "#e54888"];

export type PixelChange = { x: number; y: number; color: string };
export type PixelAction =
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
export type PixelPatch = {
  indices: number[];
  before: number[];
  after: number[];
  historyGroup: number | null;
  selectionBefore?: SelectionBounds;
  selectionAfter?: SelectionBounds;
};
export type HistoryState = { version: number; undoDepth: number; redoDepth: number };
export type EditOutcome = { changed: boolean; bounds: SelectionBounds | null };
export type RegionTransform = "flip-left-right" | "flip-top-bottom" | "rotate";
export type Viewport = { x: number; y: number; zoom: number };
export type SelectionBounds = { minX: number; minY: number; maxX: number; maxY: number };
export type CopiedSelection = { pixels: PixelChange[]; width: number; height: number; origin: ScreenPoint };
export type MovingSelection = { originalBounds: SelectionBounds; captured: CopiedSelection };
export type ScreenPoint = { x: number; y: number };
export type ShapeTool = "line" | "rectangle" | "ellipse";
export type ColorTool = "paint" | "fill" | ShapeTool;
export type Tool = ColorTool | "erase" | "picker" | "pan" | "select";
export type ShapeStyle = "outline" | "filled";
export type Symmetry = { horizontal: boolean; vertical: boolean };
export type ExportMode = "scale" | "dimensions";
export type ImportGrid = {
  columns: number;
  rows: number;
  originX: number;
  originY: number;
  pitch: number;
};
export type ImportSource = ImportGrid & {
  name: string;
  data: Uint8ClampedArray;
  width: number;
  height: number;
};
export type FillResult = {
  changes: PixelChange[];
  reason?: "same-color" | "off-canvas";
};
export type PersistedEditorState = {
  cells: Uint32Array;
  viewport: Viewport;
  selectedColor: string;
  customColors: string[];
  autoFollow: boolean;
};
export type PointerState =
  | {
      kind: "draw";
      pointerId: number;
      lastPixel: ScreenPoint;
      historyGroup: number;
      color: string;
      brush: number;
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

export const isOnCanvas = (x: number, y: number) =>
  x >= CANVAS_MIN && x <= CANVAS_MAX && y >= CANVAS_MIN && y <= CANVAS_MAX;

export const cellIndex = (x: number, y: number) => (y - CANVAS_MIN) * CANVAS_SIZE + (x - CANVAS_MIN);

export const cellX = (index: number) => (index % CANVAS_SIZE) + CANVAS_MIN;

export const cellY = (index: number) => Math.floor(index / CANVAS_SIZE) + CANVAS_MIN;

export const cellFromColor = (color: string) => (0xff000000 | parseInt(color.slice(1), 16)) >>> 0;

export const colorFromCell = (cell: number) => `#${((cell & 0xffffff) | 0x1000000).toString(16).slice(1)}`;

export const clampToCanvas = (value: number) => Math.max(CANVAS_MIN, Math.min(CANVAS_MAX, value));

/**
 * Clamps a rectangle to the canvas, or returns null when it does not overlap at
 * all. `clampSelectionToCanvas` moves each edge independently, so a wholly
 * off-canvas rectangle collapses onto the nearest real row or column instead of
 * vanishing — which silently makes an out-of-range request act on live pixels.
 */
export function intersectCanvas(bounds: SelectionBounds): SelectionBounds | null {
  if (bounds.maxX < CANVAS_MIN || bounds.minX > CANVAS_MAX) return null;
  if (bounds.maxY < CANVAS_MIN || bounds.minY > CANVAS_MAX) return null;
  return clampSelectionToCanvas(bounds);
}

export function clampSelectionToCanvas(bounds: SelectionBounds): SelectionBounds {
  return {
    minX: clampToCanvas(bounds.minX),
    minY: clampToCanvas(bounds.minY),
    maxX: clampToCanvas(bounds.maxX),
    maxY: clampToCanvas(bounds.maxY),
  };
}
export function isColorTool(tool: Tool): tool is ColorTool {
  return tool === "paint" || tool === "fill" || tool === "line" || tool === "rectangle" || tool === "ellipse";
}

export function isShapeTool(tool: Tool): tool is ShapeTool {
  return tool === "line" || tool === "rectangle" || tool === "ellipse";
}

export function supportsSymmetry(tool: Tool) {
  return tool === "paint" || tool === "erase" || tool === "fill" || isShapeTool(tool);
}
export type PixelStore = {
  cells: Uint32Array;
  undoStack: PixelPatch[];
  redoStack: PixelPatch[];
  cellCount: number;
};

export function createPixelStore(cells: Uint32Array): PixelStore {
  return { cells, undoStack: [], redoStack: [], cellCount: 0 };
}

export function recordCell(patch: PixelPatch, index: number, before: number, after: number) {
  patch.indices.push(index);
  patch.before.push(before);
  patch.after.push(after);
}

export function trimHistory(store: PixelStore) {
  while (
    store.undoStack.length > HISTORY_LIMIT ||
    (store.cellCount > HISTORY_CELL_LIMIT && store.undoStack.length > 1)
  ) {
    const dropped = store.undoStack.shift();
    if (!dropped) return;
    store.cellCount -= dropped.indices.length;
  }
}

export function writeCell(store: PixelStore, patch: PixelPatch, x: number, y: number, value: number) {
  if (!isOnCanvas(x, y)) return;
  const index = cellIndex(x, y);
  const before = store.cells[index];
  if (before === value) return;
  store.cells[index] = value;
  recordCell(patch, index, before, value);
}

export function clearArea(store: PixelStore, patch: PixelPatch, bounds: SelectionBounds) {
  const area = clampSelectionToCanvas(bounds);
  for (let y = area.minY; y <= area.maxY; y += 1) {
    for (let x = area.minX; x <= area.maxX; x += 1) {
      writeCell(store, patch, x, y, EMPTY_CELL);
    }
  }
}

export function applyPixelChanges(store: PixelStore, patch: PixelPatch, changes: PixelChange[]) {
  for (const { x, y, color } of changes) {
    writeCell(store, patch, x, y, color === EMPTY_PIXEL ? EMPTY_CELL : cellFromColor(color));
  }
}

export function indicesBounds(indices: number[], from = 0): SelectionBounds | null {
  if (from >= indices.length) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let entry = from; entry < indices.length; entry += 1) {
    const x = cellX(indices[entry]);
    const y = cellY(indices[entry]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function applyPixelAction(store: PixelStore, action: PixelAction): EditOutcome {
  if (action.type === "undo") {
    const patch = store.undoStack.pop();
    if (!patch) return { changed: false, bounds: null };
    for (let entry = patch.indices.length - 1; entry >= 0; entry -= 1) {
      store.cells[patch.indices[entry]] = patch.before[entry];
    }
    store.redoStack.push(patch);
    return { changed: true, bounds: indicesBounds(patch.indices) };
  }

  if (action.type === "redo") {
    const patch = store.redoStack.pop();
    if (!patch) return { changed: false, bounds: null };
    for (let entry = 0; entry < patch.indices.length; entry += 1) {
      store.cells[patch.indices[entry]] = patch.after[entry];
    }
    store.undoStack.push(patch);
    return { changed: true, bounds: indicesBounds(patch.indices) };
  }

  const historyGroup = action.type === "paint" ? (action.historyGroup ?? null) : null;
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
  if (written === 0) return { changed: false, bounds: null };
  const bounds = indicesBounds(patch.indices, started);
  for (const dropped of store.redoStack) store.cellCount -= dropped.indices.length;
  store.redoStack.length = 0;
  store.cellCount += written;
  if (!continues) store.undoStack.push(patch);
  trimHistory(store);
  return { changed: true, bounds };
}

export function readPaintedPixels(cells: Uint32Array) {
  const painted: { x: number; y: number; color: string }[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    if (cells[index] === EMPTY_CELL) continue;
    painted.push({ x: cellX(index), y: cellY(index), color: colorFromCell(cells[index]) });
  }
  return painted;
}

export function countPaintedCells(cells: Uint32Array, bounds?: SelectionBounds) {
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

export function isCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= CANVAS_MIN && Number(value) <= CANVAS_MAX;
}

export function clampZoom(zoom: number, minZoom = MIN_ZOOM) {
  return Math.min(MAX_ZOOM, Math.max(minZoom, zoom));
}

export function fitZoomFor(view: { width: number; height: number }) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(view.width, view.height) / CANVAS_SIZE));
}

export function clampViewport(viewport: Viewport, view?: { width: number; height: number }): Viewport {
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

export function selectionBounds(from: { x: number; y: number }, to: { x: number; y: number }): SelectionBounds {
  return {
    minX: Math.min(from.x, to.x),
    minY: Math.min(from.y, to.y),
    maxX: Math.max(from.x, to.x),
    maxY: Math.max(from.y, to.y),
  };
}

export function floodFill(cells: Uint32Array, start: ScreenPoint, color: string): FillResult {
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

export function getPinchMetrics(points: Map<number, ScreenPoint>) {
  const [first, second] = Array.from(points.values());
  if (!first || !second) return null;
  return {
    center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
  };
}

export function readStoredColors(value: unknown, limit: number) {
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

export function writeVarint(bytes: number[], value: number) {
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
}

export function readVarint(bytes: Uint8Array, cursor: { at: number }) {
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

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

export function encodeCells(cells: Uint32Array) {
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

export function decodeCells(palette: unknown, runs: unknown) {
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

export function loadPersistedState(): PersistedEditorState {
  const fallback: PersistedEditorState = {
    cells: new Uint32Array(CANVAS_SIZE * CANVAS_SIZE),
    viewport: { x: 0, y: 0, zoom: DEFAULT_ZOOM },
    selectedColor: PALETTE[0],
    customColors: [],
    autoFollow: true,
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
    const customColors = storedCustomColors
      .filter((color, index, colors) => colors.indexOf(color) === index)
      .slice(0, MAX_CUSTOM_COLORS);

    // Absent means on, so an older save keeps the default rather than losing it.
    return { cells, viewport, selectedColor, customColors, autoFollow: saved.autoFollow !== false };
  } catch (error) {
    console.warn("Could not restore the saved MCPixels canvas", error);
    return fallback;
  }
}

export function pixelsOnLine(from: { x: number; y: number }, to: { x: number; y: number }, color: string) {
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

export function brushStamp(points: ScreenPoint[], size: number, color: string): PixelChange[] {
  if (size <= 1) return points.map(({ x, y }) => ({ x, y, color }));
  const offset = Math.floor((size - 1) / 2);
  const stamped = new Map<string, PixelChange>();
  for (const point of points) {
    for (let y = point.y - offset; y < point.y - offset + size; y += 1) {
      for (let x = point.x - offset; x < point.x - offset + size; x += 1) {
        stamped.set(`${x},${y}`, { x, y, color });
      }
    }
  }
  return Array.from(stamped.values());
}

export function stepBrushSize(size: number, direction: number) {
  const index = BRUSH_SIZES.indexOf(size);
  const next = (index < 0 ? 0 : index) + direction;
  return BRUSH_SIZES[Math.max(0, Math.min(BRUSH_SIZES.length - 1, next))];
}

export function applySymmetry(changes: PixelChange[], symmetry: Symmetry, limit = Number.POSITIVE_INFINITY) {
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

export function pixelsInShape(
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
    const pixelCount =
      style === "filled" ? width * height : width === 1 ? height : height === 1 ? width : width * 2 + (height - 2) * 2;
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

export function sourcePixelDistance(data: Uint8ClampedArray, a: number, b: number) {
  const alphaDistance = Math.abs(data[a + 3] - data[b + 3]);
  if (data[a + 3] < IMPORT_ALPHA_THRESHOLD && data[b + 3] < IMPORT_ALPHA_THRESHOLD) return alphaDistance;
  return Math.max(
    alphaDistance,
    Math.abs(data[a] - data[b]),
    Math.abs(data[a + 1] - data[b + 1]),
    Math.abs(data[a + 2] - data[b + 2]),
  );
}

export function lineBreaks(
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

export function breakCenters(isBreak: Uint8Array, energy: Float64Array) {
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

export function gridFit(centers: number[], pitch: number) {
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

export function fitPitch(centers: number[], count: number, pitch: number, phase: number) {
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

export function refinePitch(centers: number[], guess: number) {
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

export function pitchCandidates(centers: number[]) {
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

export function axisAccepts(breaks: { centers: number[]; widest: number }, pitch: number) {
  if (breaks.centers.length === 0) return { origin: 0 };
  if (breaks.widest > pitch * 0.85) return null;
  const fit = gridFit(breaks.centers, pitch);
  if (fit.worst > Math.min(pitch * 0.25, Math.max(0.85, pitch * 0.08))) return null;
  if (fit.mean > Math.min(pitch * 0.12, Math.max(0.35, pitch * 0.04))) return null;
  return { origin: fit.phase };
}

export function detectPixelGrid(data: Uint8ClampedArray, width: number, height: number): ImportGrid {
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

export function rasterizeImportSource(source: ImportSource, width: number, height: number) {
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

export function fitImportDimensions(width: number, height: number) {
  const factor = Math.min(1, MAX_IMPORT_DIMENSION / width, MAX_IMPORT_DIMENSION / height);
  if (factor >= 1) return { width, height };
  return {
    width: Math.max(1, Math.floor(width * factor)),
    height: Math.max(1, Math.floor(height * factor)),
  };
}

export async function decodeImageFile(file: File) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      image: bitmap as CanvasImageSource,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
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

export async function readImageSize(file: File) {
  try {
    const decoded = await decodeImageFile(file);
    decoded.release();
    return { width: decoded.width, height: decoded.height };
  } catch (error) {
    console.warn("Could not read the pasted image size", error);
    return null;
  }
}

export async function readImportSource(file: File): Promise<ImportSource> {
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

export function importOriginFor(selection: SelectionBounds | null, viewport: Viewport, width: number, height: number) {
  const clamp = (value: number, size: number) => Math.max(CANVAS_MIN, Math.min(CANVAS_MAX - size + 1, value));
  return {
    x: clamp(selection ? selection.minX : Math.round(viewport.x) - Math.floor(width / 2), width),
    y: clamp(selection ? selection.minY : Math.round(viewport.y) - Math.floor(height / 2), height),
  };
}

export function findImageFile(files: FileList | null | undefined, items?: DataTransferItemList | null) {
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

export function carriesFiles(transfer: DataTransfer | null) {
  return Array.from(transfer?.types ?? []).includes("Files");
}

export function captureRegion(cells: Uint32Array, bounds: SelectionBounds): CopiedSelection {
  const pixels: PixelChange[] = [];
  const area = clampSelectionToCanvas(bounds);
  for (let y = area.minY; y <= area.maxY; y += 1) {
    for (let x = area.minX; x <= area.maxX; x += 1) {
      const cell = cells[cellIndex(x, y)];
      if (cell === EMPTY_CELL) continue;
      pixels.push({ x: x - bounds.minX, y: y - bounds.minY, color: colorFromCell(cell) });
    }
  }
  return {
    pixels,
    width: bounds.maxX - bounds.minX + 1,
    height: bounds.maxY - bounds.minY + 1,
    origin: { x: bounds.minX, y: bounds.minY },
  };
}

export function placeRegion(captured: CopiedSelection, origin: ScreenPoint): PixelChange[] {
  return captured.pixels.map(({ x, y, color }) => ({ x: origin.x + x, y: origin.y + y, color }));
}

export function transformRegion(captured: CopiedSelection, kind: RegionTransform): CopiedSelection {
  const { width, height } = captured;
  const rotated = kind === "rotate";
  const pixels = captured.pixels.map(({ x, y, color }) => {
    if (kind === "flip-left-right") return { x: width - 1 - x, y, color };
    if (kind === "flip-top-bottom") return { x, y: height - 1 - y, color };
    return { x: height - 1 - y, y: x, color };
  });
  return {
    pixels,
    width: rotated ? height : width,
    height: rotated ? width : height,
    origin: captured.origin,
  };
}

export function offsetSelection(bounds: SelectionBounds, dx: number, dy: number): SelectionBounds | null {
  if (
    bounds.minX + dx < CANVAS_MIN ||
    bounds.maxX + dx > CANVAS_MAX ||
    bounds.minY + dy < CANVAS_MIN ||
    bounds.maxY + dy > CANVAS_MAX
  ) {
    return null;
  }
  return {
    minX: bounds.minX + dx,
    minY: bounds.minY + dy,
    maxX: bounds.maxX + dx,
    maxY: bounds.maxY + dy,
  };
}

export function boundsForOrigin(origin: ScreenPoint, width: number, height: number): SelectionBounds {
  return { minX: origin.x, minY: origin.y, maxX: origin.x + width - 1, maxY: origin.y + height - 1 };
}

export function clampOriginToCanvas(origin: ScreenPoint, width: number, height: number): ScreenPoint {
  return {
    x: Math.max(CANVAS_MIN, Math.min(CANVAS_MAX - width + 1, origin.x)),
    y: Math.max(CANVAS_MIN, Math.min(CANVAS_MAX - height + 1, origin.y)),
  };
}

export function boundsOfChanges(changes: PixelChange[]): SelectionBounds | null {
  if (changes.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const { x, y } of changes) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function unionBounds(a: SelectionBounds | null, b: SelectionBounds | null): SelectionBounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function paintedBounds(cells: Uint32Array): SelectionBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let found = false;
  for (let index = 0; index < cells.length; index += 1) {
    if (cells[index] === EMPTY_CELL) continue;
    found = true;
    const x = cellX(index);
    const y = cellY(index);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return found ? { minX, minY, maxX, maxY } : null;
}

export type ViewSize = { width: number; height: number };

export function visibleRegion(viewport: Viewport, view: ViewSize, fitZoom = MIN_ZOOM, margin = 0): SelectionBounds {
  const zoom = clampZoom(viewport.zoom, fitZoom);
  return {
    minX: Math.floor(viewport.x - view.width / (2 * zoom)) - margin,
    maxX: Math.ceil(viewport.x + view.width / (2 * zoom)) + margin,
    minY: Math.floor(viewport.y - view.height / (2 * zoom)) - margin,
    maxY: Math.ceil(viewport.y + view.height / (2 * zoom)) + margin,
  };
}

export function containsRegion(outer: SelectionBounds, inner: SelectionBounds) {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

export function isRegionVisible(bounds: SelectionBounds, viewport: Viewport, view: ViewSize, fitZoom = MIN_ZOOM) {
  return containsRegion(visibleRegion(viewport, view, fitZoom), bounds);
}

export function frameViewport(
  bounds: SelectionBounds,
  view: ViewSize,
  current: Viewport,
  options?: { padding?: number },
): Viewport {
  const padding = options?.padding ?? 2;
  const width = bounds.maxX - bounds.minX + 1 + padding * 2;
  const height = bounds.maxY - bounds.minY + 1 + padding * 2;
  const needed = Math.min(view.width / width, view.height / height);
  const zoom = clampZoom(Math.min(current.zoom, needed), fitZoomFor(view));
  return clampViewport({ x: (bounds.minX + bounds.maxX + 1) / 2, y: (bounds.minY + bounds.maxY + 1) / 2, zoom }, view);
}

export function regionToScreen(bounds: SelectionBounds, viewport: Viewport, view: ViewSize) {
  return {
    left: (bounds.minX - viewport.x) * viewport.zoom + view.width / 2,
    top: (bounds.minY - viewport.y) * viewport.zoom + view.height / 2,
    width: (bounds.maxX - bounds.minX + 1) * viewport.zoom,
    height: (bounds.maxY - bounds.minY + 1) * viewport.zoom,
  };
}
