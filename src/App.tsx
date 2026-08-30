import { useEffect, useReducer, useRef, useState } from "react";
import type {
  CSSProperties,
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
const SELECTION_ACTIONS_WIDTH = 139;
const SELECTION_ACTIONS_HEIGHT = 32;
const SELECTION_ACTIONS_GAP = 8;
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
  | { type: "paint"; changes: PixelChange[] }
  | { type: "clear-area"; bounds: SelectionBounds }
  | { type: "clear" };
type Viewport = { x: number; y: number; zoom: number };
type SelectionBounds = { minX: number; minY: number; maxX: number; maxY: number };
type ScreenPoint = { x: number; y: number };
type Tool = "paint" | "erase" | "pan" | "lasso";
type PersistedEditorState = {
  pixels: Map<string, string>;
  viewport: Viewport;
  selectedColor: string;
};
type PointerState =
  | { kind: "draw"; lastPixel: { x: number; y: number } }
  | { kind: "select"; anchor: { x: number; y: number } }
  | { kind: "pinch"; lastCenter: ScreenPoint; lastDistance: number }
  | {
      kind: "pan";
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      hasDragged: boolean;
      button: number;
    }
  | null;

const pixelKey = (x: number, y: number) => `${x},${y}`;

function pixelReducer(pixels: Map<string, string>, action: PixelAction) {
  if (action.type === "clear") return new Map<string, string>();

  if (action.type === "clear-area") {
    const next = new Map(pixels);
    for (const key of pixels.keys()) {
      const [x, y] = key.split(",").map(Number);
      if (x >= action.bounds.minX && x <= action.bounds.maxX && y >= action.bounds.minY && y <= action.bounds.maxY) {
        next.delete(key);
      }
    }
    return next;
  }

  const next = new Map(pixels);
  for (const { x, y, color } of action.changes) {
    const key = pixelKey(x, y);
    if (color === EMPTY_PIXEL) next.delete(key);
    else next.set(key, color);
  }
  return next;
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

function getPinchMetrics(points: Map<number, ScreenPoint>) {
  const [first, second] = Array.from(points.values());
  if (!first || !second) return null;
  return {
    center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
  };
}

function loadPersistedState(): PersistedEditorState {
  const fallback = {
    pixels: new Map<string, string>(),
    viewport: { x: 0, y: 0, zoom: DEFAULT_ZOOM },
    selectedColor: PALETTE[0],
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

    return { pixels, viewport, selectedColor };
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

function App() {
  const [initialState] = useState(loadPersistedState);
  const [pixels, dispatch] = useReducer(pixelReducer, initialState.pixels);
  const [selectedColor, setSelectedColor] = useState(initialState.selectedColor);
  const [tool, setTool] = useState<Tool>("paint");
  const [viewport, setViewport] = useState<Viewport>(initialState.viewport);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const [activity, setActivity] = useState("Canvas ready. Pick a color and draw.");
  const [webMcpStatus, setWebMcpStatus] = useState<"checking" | "ready" | "unavailable" | "error">("checking");
  const [isPanning, setIsPanning] = useState(false);
  const [selection, setSelection] = useState<SelectionBounds | null>(null);
  const [showInfo, setShowInfo] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixelsRef = useRef(pixels);
  const viewportRef = useRef(viewport);
  const pointerRef = useRef<PointerState>(null);
  const touchPointsRef = useRef(new Map<number, ScreenPoint>());
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
          JSON.stringify({ version: 1, pixels: savedPixels, viewport, selectedColor }),
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
  }, [pixels, selectedColor, viewport]);

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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, button")) return;
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
  }, []);

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

    for (const [key, color] of pixels) {
      const [x, y] = key.split(",").map(Number);
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      context.fillStyle = color;
      context.fillRect(screenX(x), screenY(y), zoom, zoom);
    }

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

    context.beginPath();
    context.strokeStyle = "#aeb2ac";
    context.lineWidth = 1;
    context.moveTo(screenX(0), 0);
    context.lineTo(screenX(0), height);
    context.moveTo(0, screenY(0));
    context.lineTo(width, screenY(0));
    context.stroke();
  }, [canvasSize, pixels, viewport]);

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

  const startDrawingAt = (clientX: number, clientY: number) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel) return;
    const color = tool === "erase" ? EMPTY_PIXEL : selectedColor;
    pointerRef.current = { kind: "draw", lastPixel: pixel };
    dispatch({
      type: "paint",
      changes: [{ ...pixel, color }],
    });
    setActivity(`You ${tool === "erase" ? "erased" : "painted"} pixel (${pixel.x}, ${pixel.y}).`);
  };

  const continueDrawingAt = (clientX: number, clientY: number, pointer: Extract<PointerState, { kind: "draw" }>) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel || (pixel.x === pointer.lastPixel.x && pixel.y === pointer.lastPixel.y)) return;
    const color = tool === "erase" ? EMPTY_PIXEL : selectedColor;
    dispatch({ type: "paint", changes: pixelsOnLine(pointer.lastPixel, pixel, color) });
    pointerRef.current = { kind: "draw", lastPixel: pixel };
    setActivity(`You ${tool === "erase" ? "erased to" : "painted to"} pixel (${pixel.x}, ${pixel.y}).`);
  };

  const startSelectionAt = (clientX: number, clientY: number) => {
    const pixel = getPixelAt(clientX, clientY);
    if (!pixel) return;
    pointerRef.current = { kind: "select", anchor: pixel };
    setSelection(selectionBounds(pixel, pixel));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const shouldPan =
      event.button === 1 ||
      event.button === 2 ||
      tool === "pan" ||
      (event.button === 0 && spacePressedRef.current);
    const shouldSelect = event.button === 0 && !shouldPan && tool === "lasso";
    const shouldDraw = event.button === 0 && !shouldPan && !shouldSelect;
    if (!shouldPan && !shouldDraw && !shouldSelect) return;

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
      startSelectionAt(event.clientX, event.clientY);
      return;
    }
    if (shouldDraw) {
      startDrawingAt(event.clientX, event.clientY);
      return;
    }

    if (event.button === 2) suppressContextMenuRef.current = false;
    pointerRef.current = {
      kind: "pan",
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

    if (pointer.kind === "select") {
      const pixel = getPixelAt(event.clientX, event.clientY);
      if (pixel) setSelection(selectionBounds(pointer.anchor, pixel));
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

  const handlePointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    touchPointsRef.current.delete(event.pointerId);
    if (pointerRef.current?.kind === "pinch") {
      const pinch = getPinchMetrics(touchPointsRef.current);
      if (pinch) {
        pointerRef.current = {
          kind: "pinch",
          lastCenter: pinch.center,
          lastDistance: pinch.distance,
        };
      } else {
        const remainingTouch = Array.from(touchPointsRef.current.values())[0];
        pointerRef.current = remainingTouch
          ? {
              kind: "pan",
              startX: remainingTouch.x,
              startY: remainingTouch.y,
              lastX: remainingTouch.x,
              lastY: remainingTouch.y,
              hasDragged: true,
              button: 0,
            }
          : null;
        setIsPanning(Boolean(remainingTouch));
      }
      return;
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
    unavailable: "WebMCP browser required",
    error: "Tool registration failed",
  }[webMcpStatus];

  const selectionScreen = selection
    ? {
        left: (selection.minX - viewport.x) * viewport.zoom + canvasSize.width / 2,
        top: (selection.minY - viewport.y) * viewport.zoom + canvasSize.height / 2,
        width: (selection.maxX - selection.minX + 1) * viewport.zoom,
        height: (selection.maxY - selection.minY + 1) * viewport.zoom,
      }
    : null;
  const selectionActionsStyle = selectionScreen
    ? {
        left: Math.min(
          Math.max(SELECTION_ACTIONS_GAP, selectionScreen.left + selectionScreen.width - SELECTION_ACTIONS_WIDTH),
          Math.max(SELECTION_ACTIONS_GAP, canvasSize.width - SELECTION_ACTIONS_WIDTH - SELECTION_ACTIONS_GAP),
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

  const dismissSelection = () => {
    setSelection(null);
    setActivity("Selection dismissed.");
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
        {showInfo ? (
          <aside className="info-card">
            <button type="button" aria-label="Hide instructions" onClick={() => setShowInfo(false)}>×</button>
            <p>Draw with Pencil, or drag a rectangle with Lasso. Use Hand to pan and pinch to zoom on touch screens.</p>
          </aside>
        ) : (
          <button className="show-info" type="button" onClick={() => setShowInfo(true)}>Show info</button>
        )}

        <div className="toolbar" aria-label="Drawing controls">
          <fieldset className="color-control">
            <legend>Color</legend>
            <div className="palette">
              {PALETTE.map((color) => (
                <button
                  key={color}
                  className={tool === "paint" && selectedColor === color ? "swatch swatch--active" : "swatch"}
                  style={{ "--swatch": color } as CSSProperties}
                  type="button"
                  aria-label={`Use color ${color}`}
                  aria-pressed={tool === "paint" && selectedColor === color}
                  onClick={() => {
                    setSelectedColor(color);
                    setTool("paint");
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
                    setSelectedColor(event.target.value);
                    setTool("paint");
                  }}
                />
              </label>
            </div>
          </fieldset>

          <fieldset className="mode-control">
            <legend>Tool</legend>
            <div className="segmented-control">
              {(["paint", "erase", "pan", "lasso"] as Tool[]).map((mode) => (
                <button
                  key={mode}
                  className={tool === mode ? "segment segment--active" : "segment"}
                  type="button"
                  aria-pressed={tool === mode}
                  onClick={() => setTool(mode)}
                >
                  {mode === "paint" ? "Pencil" : mode === "erase" ? "Eraser" : mode === "pan" ? "Hand" : "Lasso"}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="zoom-control">
            <legend>Zoom</legend>
            <div className="zoom-buttons">
              <button type="button" aria-label="Zoom out" onClick={() => zoomTo(viewport.zoom / 1.2)}>−</button>
              <output aria-label="Current zoom">{Math.round(viewport.zoom)}px</output>
              <button type="button" aria-label="Zoom in" onClick={() => zoomTo(viewport.zoom * 1.2)}>+</button>
              <button
                className="home-button"
                type="button"
                onClick={() => setViewport({ x: 0, y: 0, zoom: DEFAULT_ZOOM })}
              >
                Center
              </button>
            </div>
          </fieldset>

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

        <div className="canvas-column">
          <canvas
            ref={canvasRef}
            className={`pixel-canvas pixel-canvas--${tool}${isPanning ? " pixel-canvas--panning" : ""}`}
            aria-label="Unbounded pixel canvas. Left-drag to draw, right-drag or Space-drag to pan, and use the mouse wheel to zoom."
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
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
              <div className="selection-actions" style={selectionActionsStyle} aria-label="Selection actions">
                <button type="button" onClick={clearSelection} aria-label="Clear selected pixels" title="Clear selected pixels">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3.5 4.5h9M6 4.5v-2h4v2m1.5 0-.6 9h-5.8l-.6-9M7 7v4M9 7v4" />
                  </svg>
                </button>
                <button
                  className="selection-action--placeholder"
                  type="button"
                  onClick={dismissSelection}
                  aria-label="Copy selection (coming soon)"
                  title="Copy coming soon"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="5.5" y="5.5" width="7" height="7" />
                    <path d="M3.5 10.5h-1v-8h8v1" />
                  </svg>
                </button>
                <button
                  className="selection-action--placeholder"
                  type="button"
                  onClick={dismissSelection}
                  aria-label="Export selection (coming soon)"
                  title="Export coming soon"
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
            </>
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
