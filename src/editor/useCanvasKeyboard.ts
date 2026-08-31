import { useEffect } from "react";
import { clampViewport, isColorTool } from "../pixels.ts";
import type { ScreenPoint } from "../pixels.ts";
import { TOOL_SHORTCUTS } from "./constants.tsx";
import { useEditorRuntime } from "./EditorProvider.tsx";

/**
 * Installs the window-level shortcuts once. State comes from the runtime's
 * `latest` snapshot and behaviour from its `actions` ref, so the listener never
 * goes stale and never has to be re-bound.
 */
export function useCanvasKeyboard() {
  const runtime = useEditorRuntime();

  useEffect(() => {
    const {
      latest,
      actions,
      spacePressedRef,
      toolBeforePickerRef,
      setActivity,
      setCanvasMenu,
      setDockPanel,
      setSelection,
      setTool,
      setViewport,
      interruptView,
    } = runtime;

    const handleKeyDown = (event: KeyboardEvent) => {
      const { showExport, showImport, dockPanel, canvasMenu, selection, history, canvasSize, tool } = latest.current;
      const panelOpen = showExport || showImport;
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select") || target?.isContentEditable;
      const modifierPressed = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const wantsUndo = modifierPressed && key === "z" && !event.shiftKey;
      const wantsRedo = modifierPressed && ((key === "z" && event.shiftKey) || key === "y");

      if (!isTyping && key === "escape") {
        if (dockPanel || canvasMenu) {
          event.preventDefault();
          setDockPanel(null);
          setCanvasMenu(null);
          return;
        }
        if (!panelOpen && selection) {
          event.preventDefault();
          setSelection(null);
          setActivity("Selection dismissed.");
          return;
        }
      }

      if (!panelOpen && !isTyping && wantsUndo && history.undoDepth > 0) {
        event.preventDefault();
        actions.current.undo();
        return;
      }
      if (!panelOpen && !isTyping && wantsRedo && history.redoDepth > 0) {
        event.preventDefault();
        actions.current.redo();
        return;
      }
      if (!panelOpen && !isTyping && modifierPressed && !event.shiftKey && !event.altKey && !event.repeat) {
        if (key === "c" && selection) {
          event.preventDefault();
          actions.current.copySelection();
          return;
        }
        if (key === "x" && selection) {
          event.preventDefault();
          actions.current.cutSelection();
          return;
        }
        if (key === "a") {
          event.preventDefault();
          actions.current.selectWholeCanvas();
          return;
        }
      }
      if (!panelOpen && !isTyping && !modifierPressed && selection && (key === "delete" || key === "backspace")) {
        event.preventDefault();
        actions.current.clearSelection();
        return;
      }
      if (!panelOpen && !isTyping && !modifierPressed && !event.altKey && (key === "[" || key === "]")) {
        event.preventDefault();
        actions.current.adjustBrushSize(key === "]" ? 1 : -1);
        return;
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
          actions.current.moveSelectionBy(arrowMove.x, arrowMove.y);
        } else {
          interruptView.current();
          setViewport((current) =>
            clampViewport(
              {
                ...current,
                x: current.x + (arrowMove.x * 40) / current.zoom,
                y: current.y + (arrowMove.y * 40) / current.zoom,
              },
              canvasSize,
            ),
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
        setActivity(
          `${shortcutTool === "paint" ? "Draw" : shortcutTool[0].toUpperCase() + shortcutTool.slice(1)} tool selected.`,
        );
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
  }, [runtime]);
}
