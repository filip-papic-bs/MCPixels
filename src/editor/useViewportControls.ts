import { DEFAULT_ZOOM, clampViewport, clampZoom, fitZoomFor, frameViewport } from "../pixels.ts";
import type { ScreenPoint, SelectionBounds } from "../pixels.ts";
import { useEditorRuntime, useEditorState } from "./EditorProvider.tsx";

export function useViewportControls() {
  const { canvasSize } = useEditorState();
  const { viewportRef, canvasSizeRef, setViewport, setCanvasMenu, interruptView } = useEditorRuntime();

  const zoomTo = (nextZoom: number, point?: ScreenPoint) => {
    interruptView.current();
    setViewport((current) => {
      const zoom = clampZoom(nextZoom, fitZoomFor(canvasSize));
      if (zoom === current.zoom) return current;
      const anchor = point ?? { x: canvasSize.width / 2, y: canvasSize.height / 2 };
      const worldX = current.x + (anchor.x - canvasSize.width / 2) / current.zoom;
      const worldY = current.y + (anchor.y - canvasSize.height / 2) / current.zoom;
      return clampViewport(
        {
          x: worldX - (anchor.x - canvasSize.width / 2) / zoom,
          y: worldY - (anchor.y - canvasSize.height / 2) / zoom,
          zoom,
        },
        canvasSize,
      );
    });
  };

  const zoomBy = (factor: number) => zoomTo(viewportRef.current.zoom * factor);

  const centerView = () => {
    interruptView.current();
    setViewport({ x: 0, y: 0, zoom: DEFAULT_ZOOM });
    setCanvasMenu(null);
  };

  const frameRegion = (bounds: SelectionBounds) => {
    interruptView.current();
    setViewport(frameViewport(bounds, canvasSizeRef.current, viewportRef.current));
  };

  return { zoomTo, zoomBy, centerView, frameRegion };
}
