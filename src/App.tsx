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
  | { type: "clear" };
type Viewport = { x: number; y: number; zoom: number };
type Tool = "paint" | "erase" | "pan";
type PersistedEditorState = {
  pixels: Map<string, string>;
  viewport: Viewport;
  selectedColor: string;
};
type PointerState =
  | { kind: "draw"; lastPixel: { x: number; y: number } }
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
  const [showInfo, setShowInfo] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixelsRef = useRef(pixels);
  const viewportRef = useRef(viewport);
  const pointerRef = useRef<PointerState>(null);
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

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const shouldPan =
      event.button === 1 ||
      event.button === 2 ||
      tool === "pan" ||
      (event.button === 0 && spacePressedRef.current);
    const shouldDraw = event.button === 0 && !shouldPan;
    if (!shouldPan && !shouldDraw) return;

    if (event.button !== 2) event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
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
    const pointer = pointerRef.current;
    if (!pointer || !event.currentTarget.hasPointerCapture(event.pointerId)) return;

    if (pointer.kind === "draw") {
      continueDrawingAt(event.clientX, event.clientY, pointer);
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
            <p>Left-drag to draw. Right-drag, middle-drag, or hold Space to move. On touch, choose Hand to move.</p>
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
              {(["paint", "erase", "pan"] as Tool[]).map((mode) => (
                <button
                  key={mode}
                  className={tool === mode ? "segment segment--active" : "segment"}
                  type="button"
                  aria-pressed={tool === mode}
                  onClick={() => setTool(mode)}
                >
                  {mode === "paint" ? "Pencil" : mode === "erase" ? "Eraser" : "Hand"}
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
