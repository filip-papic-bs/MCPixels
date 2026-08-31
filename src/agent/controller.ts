import type {
  CopiedSelection,
  EditOutcome,
  HistoryState,
  PixelAction,
  PixelPatch,
  SelectionBounds,
  ViewSize,
  Viewport,
} from "../pixels.ts";
import type { NoticeMeta } from "../editor/constants.tsx";

/**
 * Everything the agent layer is allowed to do to the editor.
 *
 * Imports nothing from React on purpose: the tool definitions must not be able
 * to reach into component closures, which is where stale state comes from.
 * Pure geometry (capture, transform, place, encode) is imported straight from
 * `pixels.ts` instead of being proxied through here.
 */
export type EditorController = {
  readonly canvas: { size: number; minX: number; minY: number; maxX: number; maxY: number };

  /** The live cell array. Read-only by contract — copying 4 MB per read is not viable. */
  getCells(): Uint32Array;
  countPainted(bounds?: SelectionBounds): number;
  getHistory(): HistoryState;
  peekUndo(): PixelPatch | undefined;
  peekRedo(): PixelPatch | undefined;

  /** Takes the next shared history group, so one tool call is one undo step. */
  beginGroup(): number;
  apply(action: PixelAction): EditOutcome;

  getViewport(): Viewport;
  getViewSize(): ViewSize;
  frameRegion(bounds: SelectionBounds): Viewport;
  isPersonDrawing(): boolean;

  getSelection(): SelectionBounds | null;
  setSelection(next: SelectionBounds | null): void;
  getClipboard(): CopiedSelection | null;
  setClipboard(clip: CopiedSelection | null): void;

  exportPng(
    bounds: SelectionBounds,
    scale: number,
    signal?: AbortSignal,
  ): Promise<{ file: string; width: number; height: number; scale: number }>;

  notify(text: string, meta?: NoticeMeta): void;
  setWorking(working: boolean): void;
};
