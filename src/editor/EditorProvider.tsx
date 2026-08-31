import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  CANVAS_SIZE,
  DEFAULT_EXPORT_SCALE,
  PALETTE,
  STORAGE_KEY,
  STORAGE_VERSION,
  applyPixelAction,
  clampViewport,
  createPixelStore,
  encodeCells,
  fitZoomFor,
  loadPersistedState,
} from "../pixels.ts";
import type {
  ColorTool,
  CopiedSelection,
  EditOutcome,
  ExportMode,
  HistoryState,
  ImportSource,
  MovingSelection,
  PixelAction,
  PixelChange,
  PixelStore,
  PointerState,
  ScreenPoint,
  SelectionBounds,
  ShapeStyle,
  Symmetry,
  Tool,
  ViewSize,
  Viewport,
} from "../pixels.ts";
import { createPaintCaches } from "../render/painter.ts";
import type { PaintCaches } from "../render/painter.ts";
import { useNotices } from "./useNotices.ts";
import type { CanvasMenu, DockPanel, Notice, NoticeMeta } from "./constants.tsx";
import type { EditorActions } from "./actions.ts";

export type WebMcpStatus = "checking" | "ready" | "working" | "unavailable" | "error";

/**
 * Every value the UI renders from. A new object each render, so anything that
 * reads it re-renders — which is what you want for values that are drawn.
 */
export type EditorSnapshot = {
  history: HistoryState;
  selectedColor: string;
  customColors: string[];
  pendingColor: string | null;
  tool: Tool;
  shapeStyle: ShapeStyle;
  brushSize: number;
  symmetry: Symmetry;
  shapePreview: PixelChange[];
  touchPreview: PixelChange[];
  viewport: Viewport;
  canvasSize: ViewSize;
  fitZoom: number;
  webMcpStatus: WebMcpStatus;
  toolCount: number;
  isPanning: boolean;
  selection: SelectionBounds | null;
  movingSelection: MovingSelection | null;
  copiedSelection: CopiedSelection | null;
  showExport: boolean;
  exportMode: ExportMode;
  exportScale: number;
  exportDimensions: ViewSize;
  lockExportRatio: boolean;
  exportError: string;
  isExporting: boolean;
  showImport: boolean;
  importSource: ImportSource | null;
  importDimensions: ViewSize;
  lockImportRatio: boolean;
  importError: string;
  isReadingImport: boolean;
  isDropTarget: boolean;
  storageError: string;
  dockPanel: DockPanel;
  canvasMenu: CanvasMenu;
  selectionActionsSize: ViewSize;
  autoFollow: boolean;
  activity: string;
  notices: Notice[];
};

type Setter<T> = (next: T | ((current: T) => T)) => void;

/**
 * Functions and refs only, with an identity that never changes. Reading it
 * never re-renders you, so it is safe to consume from a memoized component and
 * from mount-once effects that must still see live state.
 */
export type EditorRuntime = {
  store: PixelStore;
  cells: Uint32Array;
  dispatch: (action: PixelAction) => EditOutcome;
  latest: RefObject<EditorSnapshot>;
  /** Filled by the editor each render. Call from handlers, never read in render. */
  actions: RefObject<EditorActions>;
  /** Set by useAutoFollow; every agent write reports the box it touched. */
  agentEdit: RefObject<(bounds: SelectionBounds | null) => void>;
  /** Set by useViewportAnimation; stops an in-flight glide. */
  interruptView: RefObject<() => void>;

  canvasRef: RefObject<HTMLCanvasElement | null>;
  canvasMenuRef: RefObject<HTMLDivElement | null>;
  selectionActionsRef: RefObject<HTMLDivElement | null>;
  importInputRef: RefObject<HTMLInputElement | null>;
  viewportRef: RefObject<Viewport>;
  canvasSizeRef: RefObject<ViewSize>;
  paintCachesRef: RefObject<PaintCaches>;
  pointerRef: RefObject<PointerState>;
  historyGroupRef: RefObject<number>;
  toolBeforePickerRef: RefObject<ColorTool>;
  touchPointsRef: RefObject<Map<number, ScreenPoint>>;
  shapePreviewFrameRef: RefObject<number | null>;
  spacePressedRef: RefObject<boolean>;
  lastCanvasPointerRef: RefObject<ScreenPoint | null>;
  selectionBeforeTouchRef: RefObject<SelectionBounds | null>;
  rightDragEndedAtRef: RefObject<number>;
  contextMenuOpenedAtRef: RefObject<number>;
  holdTimerRef: RefObject<number | null>;
  heldOpenRef: RefObject<boolean>;
  selectionBeforeExportRef: RefObject<SelectionBounds | null>;
  exportReplacedSelectionRef: RefObject<boolean>;
  clipboardPngRef: RefObject<{ width: number; height: number } | null>;

  setSelectedColor: Setter<string>;
  setCustomColors: Setter<string[]>;
  setPendingColor: Setter<string | null>;
  setTool: Setter<Tool>;
  setShapeStyle: Setter<ShapeStyle>;
  setBrushSize: Setter<number>;
  setSymmetry: Setter<Symmetry>;
  setShapePreview: Setter<PixelChange[]>;
  setTouchPreview: Setter<PixelChange[]>;
  setViewport: Setter<Viewport>;
  setWebMcpStatus: Setter<WebMcpStatus>;
  setToolCount: Setter<number>;
  setIsPanning: Setter<boolean>;
  setSelection: Setter<SelectionBounds | null>;
  setMovingSelection: Setter<MovingSelection | null>;
  setCopiedSelection: Setter<CopiedSelection | null>;
  setShowExport: Setter<boolean>;
  setExportMode: Setter<ExportMode>;
  setExportScale: Setter<number>;
  setExportDimensions: Setter<ViewSize>;
  setLockExportRatio: Setter<boolean>;
  setExportError: Setter<string>;
  setIsExporting: Setter<boolean>;
  setShowImport: Setter<boolean>;
  setImportSource: Setter<ImportSource | null>;
  setImportDimensions: Setter<ViewSize>;
  setLockImportRatio: Setter<boolean>;
  setImportError: Setter<string>;
  setIsReadingImport: Setter<boolean>;
  setIsDropTarget: Setter<boolean>;
  setDockPanel: Setter<DockPanel>;
  setCanvasMenu: Setter<CanvasMenu>;
  setSelectionActionsSize: Setter<ViewSize>;
  setAutoFollow: Setter<boolean>;
  setActivity: (text: string) => void;
  notify: (text: string, meta?: NoticeMeta) => void;
};

const SnapshotContext = createContext<EditorSnapshot | null>(null);
const RuntimeContext = createContext<EditorRuntime | null>(null);

export function useEditorState() {
  const snapshot = useContext(SnapshotContext);
  if (!snapshot) throw new Error("useEditorState must be used inside an EditorProvider");
  return snapshot;
}

export function useEditorRuntime() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("useEditorRuntime must be used inside an EditorProvider");
  return runtime;
}

export function EditorProvider({ children }: { children: ReactNode }) {
  const [initialState] = useState(loadPersistedState);
  const storeRef = useRef<PixelStore | null>(null);
  if (storeRef.current === null) storeRef.current = createPixelStore(initialState.cells);
  const store = storeRef.current;
  const cells = store.cells;

  const [history, setHistory] = useState<HistoryState>({ version: 0, undoDepth: 0, redoDepth: 0 });
  const { activity, setActivity, notices, notify } = useNotices();

  const [selectedColor, setSelectedColor] = useState(initialState.selectedColor);
  const [customColors, setCustomColors] = useState(initialState.customColors);
  const [pendingColor, setPendingColor] = useState<string | null>(
    PALETTE.includes(initialState.selectedColor) || initialState.customColors.includes(initialState.selectedColor)
      ? null
      : initialState.selectedColor,
  );
  const [tool, setTool] = useState<Tool>("paint");
  const [shapeStyle, setShapeStyle] = useState<ShapeStyle>("outline");
  const [brushSize, setBrushSize] = useState(1);
  const [symmetry, setSymmetry] = useState<Symmetry>({ horizontal: false, vertical: false });
  const [shapePreview, setShapePreview] = useState<PixelChange[]>([]);
  const [touchPreview, setTouchPreview] = useState<PixelChange[]>([]);
  const [viewport, setViewport] = useState<Viewport>(initialState.viewport);
  const [canvasSize, setCanvasSize] = useState<ViewSize>({ width: 1, height: 1 });
  const [webMcpStatus, setWebMcpStatus] = useState<WebMcpStatus>("checking");
  const [toolCount, setToolCount] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const [selection, setSelection] = useState<SelectionBounds | null>(null);
  const [movingSelection, setMovingSelection] = useState<MovingSelection | null>(null);
  const [copiedSelection, setCopiedSelection] = useState<CopiedSelection | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [exportMode, setExportMode] = useState<ExportMode>("scale");
  const [exportScale, setExportScale] = useState(DEFAULT_EXPORT_SCALE);
  const [exportDimensions, setExportDimensions] = useState<ViewSize>({ width: 1, height: 1 });
  const [lockExportRatio, setLockExportRatio] = useState(true);
  const [exportError, setExportError] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importSource, setImportSource] = useState<ImportSource | null>(null);
  const [importDimensions, setImportDimensions] = useState<ViewSize>({ width: 1, height: 1 });
  const [lockImportRatio, setLockImportRatio] = useState(true);
  const [importError, setImportError] = useState("");
  const [isReadingImport, setIsReadingImport] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [dockPanel, setDockPanel] = useState<DockPanel>(null);
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenu>(null);
  const [selectionActionsSize, setSelectionActionsSize] = useState<ViewSize>({ width: 0, height: 0 });
  const [autoFollow, setAutoFollow] = useState(initialState.autoFollow);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasMenuRef = useRef<HTMLDivElement>(null);
  const selectionActionsRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef(viewport);
  const canvasSizeRef = useRef(canvasSize);
  const paintCachesRef = useRef(createPaintCaches());
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
  const holdTimerRef = useRef<number | null>(null);
  const heldOpenRef = useRef(false);
  const selectionBeforeExportRef = useRef<SelectionBounds | null>(null);
  const exportReplacedSelectionRef = useRef(false);
  const clipboardPngRef = useRef<{ width: number; height: number } | null>(null);

  viewportRef.current = viewport;
  canvasSizeRef.current = canvasSize;
  const fitZoom = fitZoomFor(canvasSize);

  const snapshot: EditorSnapshot = {
    history,
    selectedColor,
    customColors,
    pendingColor,
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
  };

  // Written during render, the same idiom the editor already used for
  // viewportRef, so anything reading it outside render sees this pass's values.
  const latest = useRef(snapshot);
  latest.current = snapshot;

  // Filled by Editor during the same render, before any consumer can invoke it.
  // biome-ignore lint/style/noNonNullAssertion: the ref intentionally has no callable pre-render value
  const actions = useRef<EditorActions>(null!);
  const agentEdit = useRef<(bounds: SelectionBounds | null) => void>(() => {});
  const interruptView = useRef<() => void>(() => {});
  const runtimeRef = useRef<EditorRuntime | null>(null);
  if (runtimeRef.current === null) {
    const dispatch = (action: PixelAction): EditOutcome => {
      const outcome = applyPixelAction(store, action);
      if (!outcome.changed) return outcome;
      setHistory((current) => ({
        version: current.version + 1,
        undoDepth: store.undoStack.length,
        redoDepth: store.redoStack.length,
      }));
      return outcome;
    };

    runtimeRef.current = {
      store,
      cells,
      dispatch,
      latest,
      actions,
      agentEdit,
      interruptView,
      canvasRef,
      canvasMenuRef,
      selectionActionsRef,
      importInputRef,
      viewportRef,
      canvasSizeRef,
      paintCachesRef,
      pointerRef,
      historyGroupRef,
      toolBeforePickerRef,
      touchPointsRef,
      shapePreviewFrameRef,
      spacePressedRef,
      lastCanvasPointerRef,
      selectionBeforeTouchRef,
      rightDragEndedAtRef,
      contextMenuOpenedAtRef,
      holdTimerRef,
      heldOpenRef,
      selectionBeforeExportRef,
      exportReplacedSelectionRef,
      clipboardPngRef,
      setSelectedColor,
      setCustomColors,
      setPendingColor,
      setTool,
      setShapeStyle,
      setBrushSize,
      setSymmetry,
      setShapePreview,
      setTouchPreview,
      setViewport,
      setWebMcpStatus,
      setToolCount,
      setIsPanning,
      setSelection,
      setMovingSelection,
      setCopiedSelection,
      setShowExport,
      setExportMode,
      setExportScale,
      setExportDimensions,
      setLockExportRatio,
      setExportError,
      setIsExporting,
      setShowImport,
      setImportSource,
      setImportDimensions,
      setLockImportRatio,
      setImportError,
      setIsReadingImport,
      setIsDropTarget,
      setDockPanel,
      setCanvasMenu,
      setSelectionActionsSize,
      setAutoFollow,
      setActivity,
      notify,
    };
  }

  // `setActivity` and `notify` come from useNotices and are recreated each
  // render, so refresh just those two rather than rebuilding the runtime.
  runtimeRef.current.setActivity = setActivity;
  runtimeRef.current.notify = notify;

  useEffect(() => {
    const save = () => {
      const cached = encodedCellsRef.current;
      const encoded = cached && cached.version === history.version ? cached.encoded : encodeCells(cells);
      encodedCellsRef.current = { version: history.version, encoded };
      if (!encoded) {
        setStorageError(
          "This canvas is too detailed to save in this browser. Recent changes will be lost if you reload.",
        );
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
            autoFollow,
          }),
        );
        setStorageError("");
      } catch (error) {
        console.warn("Could not save the MCPixels canvas", error);
        const size = Math.round(encoded.runs.length / 1024);
        setStorageError(
          `This browser refused to store the canvas (${size} KB). Recent changes will be lost if you reload.`,
        );
      }
    };

    const timeout = window.setTimeout(save, 200);
    window.addEventListener("pagehide", save);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pagehide", save);
    };
  }, [autoFollow, cells, customColors, history.version, selectedColor, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(1, Math.floor(entry.contentRect.width));
      const height = Math.max(1, Math.floor(entry.contentRect.height));
      setCanvasSize((current) => (current.width === width && current.height === height ? current : { width, height }));
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

  return (
    <RuntimeContext.Provider value={runtimeRef.current}>
      <SnapshotContext.Provider value={snapshot}>{children}</SnapshotContext.Provider>
    </RuntimeContext.Provider>
  );
}
