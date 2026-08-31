import { useEffect, useRef } from "react";
import { clampViewport } from "../pixels.ts";
import type { Viewport } from "../pixels.ts";
import { useEditorRuntime } from "./EditorProvider.tsx";

const GLIDE_MS = 320;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

export function useViewportAnimation() {
  const { viewportRef, canvasSizeRef, setViewport, interruptView } = useEditorRuntime();
  const frameRef = useRef<{ from: Viewport; to: Viewport; start: number; raf: number } | null>(null);

  const cancel = () => {
    if (!frameRef.current) return;
    window.cancelAnimationFrame(frameRef.current.raf);
    frameRef.current = null;
  };

  const easeTo = (target: Viewport) => {
    const clamped = clampViewport(target, canvasSizeRef.current);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      cancel();
      setViewport(clamped);
      return;
    }

    if (frameRef.current) {
      frameRef.current.from = viewportRef.current;
      frameRef.current.to = clamped;
      frameRef.current.start = performance.now();
      return;
    }

    const step = () => {
      const state = frameRef.current;
      if (!state) return;
      const progress = Math.min(1, (performance.now() - state.start) / GLIDE_MS);
      const eased = easeOutCubic(progress);
      const zoom = state.from.zoom * (state.to.zoom / state.from.zoom) ** eased;
      setViewport(
        clampViewport(
          {
            x: state.from.x + (state.to.x - state.from.x) * eased,
            y: state.from.y + (state.to.y - state.from.y) * eased,
            zoom,
          },
          canvasSizeRef.current,
        ),
      );
      if (progress >= 1) {
        frameRef.current = null;
        return;
      }
      state.raf = window.requestAnimationFrame(step);
    };

    frameRef.current = {
      from: viewportRef.current,
      to: clamped,
      start: performance.now(),
      raf: window.requestAnimationFrame(step),
    };
  };

  interruptView.current = cancel;

  useEffect(() => cancel, []);

  return { easeTo, cancel };
}
