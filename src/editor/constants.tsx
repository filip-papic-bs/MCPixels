import type { ReactElement } from "react";
import type { SelectionBounds, ShapeStyle, ShapeTool, Tool } from "../pixels.ts";
import { Icon } from "../components/icons.tsx";

export const TOOL_SHORTCUTS: Record<string, Tool> = {
  b: "paint",
  e: "erase",
  g: "fill",
  i: "picker",
  h: "pan",
  m: "select",
  l: "line",
  r: "rectangle",
  o: "ellipse",
};

export type ShapeOption = {
  key: string;
  tool: ShapeTool;
  style: ShapeStyle | null;
  label: string;
  shortcut: string;
  icon: ReactElement;
};

export const SHAPE_OPTIONS: ShapeOption[] = [
  {
    key: "line",
    tool: "line",
    style: null,
    label: "Line",
    shortcut: "L",
    icon: <Icon name="line" className="icon--diagonal" />,
  },
  {
    key: "rectangle-outline",
    tool: "rectangle",
    style: "outline",
    label: "Rectangle outline",
    shortcut: "R",
    icon: <Icon name="rectangle" />,
  },
  {
    key: "rectangle-filled",
    tool: "rectangle",
    style: "filled",
    label: "Filled rectangle",
    shortcut: "R",
    icon: <Icon name="rectangleFilled" />,
  },
  {
    key: "ellipse-outline",
    tool: "ellipse",
    style: "outline",
    label: "Ellipse outline",
    shortcut: "O",
    icon: <Icon name="ellipse" />,
  },
  {
    key: "ellipse-filled",
    tool: "ellipse",
    style: "filled",
    label: "Filled ellipse",
    shortcut: "O",
    icon: <Icon name="ellipseFilled" />,
  },
];

export function isShapeOptionActive(option: ShapeOption, tool: Tool, style: ShapeStyle) {
  if (option.tool !== tool) return false;
  return option.style === null || option.style === style;
}

export type DockPanel = "color" | "shape" | "size" | "more" | null;
export type CanvasMenu = { x: number; y: number } | null;
/** What kind of action produced a notice, used only for a colored accent. */
export type NoticeKind = "draw" | "view" | "select" | "export" | "history" | "error";
export type NoticeMeta = { kind?: NoticeKind; bounds?: SelectionBounds };
export type Notice = {
  id: number;
  text: string;
  leaving: boolean;
  count: number;
  kind?: NoticeKind;
  bounds?: SelectionBounds;
};

export type NoticeLogEntry = {
  id: number;
  text: string;
  count: number;
  at: number;
  kind?: NoticeKind;
  bounds?: SelectionBounds;
};

export const NOTICE_HOLD = 4_200;
export const NOTICE_FADE = 320;
export const NOTICE_LOG_LIMIT = 80;
export const HOLD_TO_OPEN = 420;
