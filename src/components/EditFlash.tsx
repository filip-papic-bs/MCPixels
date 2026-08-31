import { regionToScreen } from "../pixels.ts";
import type { ViewSize, Viewport } from "../pixels.ts";
import type { EditFlash as EditFlashState } from "../editor/useAutoFollow.ts";

export function EditFlash({
  flash,
  viewport,
  view,
  onDone,
}: {
  flash: EditFlashState | null;
  viewport: Viewport;
  view: ViewSize;
  onDone: () => void;
}) {
  if (!flash) return null;
  return (
    <div
      key={flash.id}
      className="edit-flash"
      style={regionToScreen(flash.bounds, viewport, view)}
      aria-hidden="true"
      onAnimationEnd={onDone}
    />
  );
}
