import { useState } from "react";
import { containsRegion, frameViewport, isRegionVisible, visibleRegion } from "../pixels.ts";
import type { SelectionBounds } from "../pixels.ts";
import { useEditorRuntime, useEditorState } from "./EditorProvider.tsx";
import { useViewportAnimation } from "./useViewportAnimation.ts";

export type EditFlash = { id: number; bounds: SelectionBounds };

export function useAutoFollow() {
  const { autoFollow } = useEditorState();
  const runtime = useEditorRuntime();
  const { agentEdit, pointerRef, latest, canvasSizeRef, viewportRef } = runtime;
  const { easeTo } = useViewportAnimation();
  const [flash, setFlash] = useState<EditFlash | null>(null);

  agentEdit.current = (bounds) => {
    if (!bounds) return;
    const state = latest.current;
    if (!state.autoFollow) return;
    if (pointerRef.current !== null) return;
    if (state.showExport || state.showImport) return;

    setFlash((current) => ({ id: (current?.id ?? 0) + 1, bounds }));

    const view = canvasSizeRef.current;
    const viewport = viewportRef.current;
    if (containsRegion(bounds, visibleRegion(viewport, view, state.fitZoom))) return;
    if (isRegionVisible(bounds, viewport, view, state.fitZoom)) return;
    easeTo(frameViewport(bounds, view, viewport));
  };

  return { flash, clearFlash: () => setFlash(null), enabled: autoFollow };
}
