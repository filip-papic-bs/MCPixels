import type { SelectionBounds, Tool } from "../pixels.ts";

export type EditorActions = {
  // history
  undo: () => void;
  redo: () => void;
  clearCanvas: () => void;

  // tools and colors
  selectTool: (tool: Tool) => void;
  selectEditorColor: (color: string) => void;
  togglePicker: () => void;
  chooseBrushSize: (size: number) => void;
  adjustBrushSize: (direction: number) => void;
  selectBrushTool: (tool: "paint" | "erase") => void;
  openBrushSizes: (tool: "paint" | "erase") => void;
  toggleSymmetry: (axis: "horizontal" | "vertical") => void;

  // view
  centerView: () => void;
  frameRegion: (bounds: SelectionBounds) => void;

  // selection
  selectWholeCanvas: () => void;
  dismissSelection: () => void;
  clearSelection: () => void;
  copySelection: () => void;
  cutSelection: () => void;
  pasteSelection: () => void;
  moveSelectionBy: (dx: number, dy: number) => void;
  flipSelectionHorizontal: () => void;
  flipSelectionVertical: () => void;
  rotateSelectionClockwise: () => void;

  // panels
  openExportPanel: (bounds?: SelectionBounds) => void;
  exportFullCanvas: () => void;
  openImportPicker: () => void;
};
