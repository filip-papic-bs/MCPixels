import { useEffect, useRef } from "react";
import { CANVAS_MAX, CANVAS_MIN, CANVAS_SIZE, countPaintedCells, frameViewport } from "../pixels.ts";
import type { CopiedSelection, SelectionBounds } from "../pixels.ts";
import { downloadBlob, fitExportScale, renderScaledPng } from "../render/raster.ts";
import { useEditorRuntime } from "../editor/EditorProvider.tsx";
import type { EditorController } from "./controller.ts";
import { registerAgentTools } from "./tools.ts";

const CANVAS_INFO = {
  size: CANVAS_SIZE,
  minX: CANVAS_MIN,
  minY: CANVAS_MIN,
  maxX: CANVAS_MAX,
  maxY: CANVAS_MAX,
} as const;

export function useWebMcpTools() {
  const runtime = useEditorRuntime();
  const {
    store,
    dispatch,
    latest,
    historyGroupRef,
    viewportRef,
    canvasSizeRef,
    setSelection,
    setCopiedSelection,
    setViewport,
    setWebMcpStatus,
    setToolCount,
    notify,
    agentEdit,
    interruptView,
    pointerRef,
  } = runtime;

  const workingTimerRef = useRef<number | null>(null);
  const activeCallsRef = useRef(0);
  const liveRef = useRef<EditorController | null>(null);
  const getLive = () => {
    const controller = liveRef.current;
    if (!controller) throw new Error("WebMCP controller is not ready");
    return controller;
  };

  const selectionRef = useRef<SelectionBounds | null>(null);
  const clipboardRef = useRef<CopiedSelection | null>(null);
  selectionRef.current = latest.current.selection;
  clipboardRef.current = latest.current.copiedSelection;

  liveRef.current = {
    canvas: CANVAS_INFO,
    getCells: () => store.cells,
    countPainted: (bounds?: SelectionBounds) => countPaintedCells(store.cells, bounds),
    getHistory: () => ({
      version: latest.current.history.version,
      undoDepth: store.undoStack.length,
      redoDepth: store.redoStack.length,
    }),
    peekUndo: () => store.undoStack.at(-1),
    peekRedo: () => store.redoStack.at(-1),
    beginGroup: () => {
      historyGroupRef.current += 1;
      return historyGroupRef.current;
    },
    apply: (action) => {
      const outcome = dispatch(action);
      if (outcome.changed) agentEdit.current(outcome.bounds);
      return outcome;
    },
    getViewport: () => viewportRef.current,
    getViewSize: () => canvasSizeRef.current,
    frameRegion: (bounds) => {
      interruptView.current();
      const next = frameViewport(bounds, canvasSizeRef.current, viewportRef.current);
      viewportRef.current = next;
      setViewport(next);
      return next;
    },
    isPersonDrawing: () => pointerRef.current !== null,

    getSelection: () => selectionRef.current,
    setSelection: (next) => {
      selectionRef.current = next;
      setSelection(next);
    },
    getClipboard: () => clipboardRef.current,
    setClipboard: (clip) => {
      clipboardRef.current = clip;
      setCopiedSelection(clip);
    },
    exportPng: async (bounds, scale, signal) => {
      const fitted = fitExportScale(bounds, scale);
      const blob = await renderScaledPng(store.cells, bounds, fitted);
      if (signal?.aborted) throw new Error("the export was cancelled");
      const file = `mcpixels-${fitted.width}x${fitted.height}.png`;
      downloadBlob(blob, file);
      return { file, width: fitted.width, height: fitted.height, scale: fitted.scale };
    },
    notify: (text, meta) => notify(text, meta),
    setWorking: (working) => {
      if (workingTimerRef.current !== null) {
        window.clearTimeout(workingTimerRef.current);
        workingTimerRef.current = null;
      }
      activeCallsRef.current = Math.max(0, activeCallsRef.current + (working ? 1 : -1));
      if (activeCallsRef.current > 0) {
        runtime.setWebMcpStatus("working");
        return;
      }
      workingTimerRef.current = window.setTimeout(() => {
        workingTimerRef.current = null;
        runtime.setWebMcpStatus("ready");
      }, 700);
    },
  };

  useEffect(() => {
    const modelContext = document.modelContext ?? navigator.modelContext;
    if (typeof modelContext?.registerTool !== "function") {
      setWebMcpStatus("unavailable");
      return;
    }

    const aborter = new AbortController();
    const proxy: EditorController = {
      canvas: CANVAS_INFO,
      getCells: () => getLive().getCells(),
      countPainted: (bounds) => getLive().countPainted(bounds),
      getHistory: () => getLive().getHistory(),
      peekUndo: () => getLive().peekUndo(),
      peekRedo: () => getLive().peekRedo(),
      beginGroup: () => getLive().beginGroup(),
      apply: (action) => getLive().apply(action),
      getViewport: () => getLive().getViewport(),
      getViewSize: () => getLive().getViewSize(),
      frameRegion: (bounds) => getLive().frameRegion(bounds),
      isPersonDrawing: () => getLive().isPersonDrawing(),
      getSelection: () => getLive().getSelection(),
      setSelection: (next) => getLive().setSelection(next),
      getClipboard: () => getLive().getClipboard(),
      setClipboard: (clip) => getLive().setClipboard(clip),
      exportPng: (bounds, scale, signal) => getLive().exportPng(bounds, scale, signal),
      notify: (text, meta) => getLive().notify(text, meta),
      setWorking: (working) => getLive().setWorking(working),
    };

    void registerAgentTools(modelContext, proxy, { signal: aborter.signal })
      .then((count) => {
        setToolCount(count);
        setWebMcpStatus("ready");
      })
      .catch((error: unknown) => {
        if (aborter.signal.aborted) return;
        console.error("WebMCP tool registration failed", error);
        setWebMcpStatus("error");
      });

    return () => aborter.abort();
  }, [setToolCount, setWebMcpStatus]);

  useEffect(
    () => () => {
      if (workingTimerRef.current !== null) window.clearTimeout(workingTimerRef.current);
    },
    [],
  );
}
