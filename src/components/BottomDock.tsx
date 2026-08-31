import { memo } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { BRUSH_SIZES, isColorTool, isShapeTool } from "../pixels.ts";
import type { ShapeStyle, Symmetry, Tool } from "../pixels.ts";
import { SHAPE_OPTIONS, isShapeOptionActive } from "../editor/constants.tsx";
import type { DockPanel } from "../editor/constants.tsx";
import { Icon } from "./icons.tsx";
import { useEditorRuntime } from "../editor/EditorProvider.tsx";

type BrushGestures = {
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
};

export const BottomDock = memo(function BottomDock({
  dockPanel,
  tool,
  shapeStyle,
  brushSize,
  symmetry,
  symmetryEnabled,
  selectedColor,
  paletteColors,
  autoFollow,
  brushSizeGestures,
}: {
  dockPanel: DockPanel;
  tool: Tool;
  shapeStyle: ShapeStyle;
  brushSize: number;
  symmetry: Symmetry;
  symmetryEnabled: boolean;
  selectedColor: string;
  paletteColors: string[];
  autoFollow: boolean;
  brushSizeGestures: BrushGestures;
}) {
  const { actions, setTool, setShapeStyle, setDockPanel, setCanvasMenu, setAutoFollow } = useEditorRuntime();

  const pickColor = (color: string) => {
    actions.current.selectEditorColor(color);
    if (!isColorTool(tool)) setTool("paint");
  };

  return (
    <div className="bottom-controls" onPointerDown={() => setCanvasMenu(null)}>
      {dockPanel === "color" ? (
        <section className="dock-popover dock-popover--color" aria-label="Color palette">
          <header>
            <span>Color</span>
            <strong>{selectedColor}</strong>
          </header>
          <div className="palette">
            {paletteColors.map((color) => (
              <button
                key={color}
                className={selectedColor === color ? "swatch swatch--active" : "swatch"}
                style={{ backgroundColor: color }}
                type="button"
                aria-label={`Use color ${color}`}
                aria-pressed={selectedColor === color}
                onClick={() => pickColor(color)}
              />
            ))}
            <label className="custom-color" title="Choose a custom color">
              <span>+</span>
              <input
                type="color"
                value={selectedColor}
                aria-label="Choose a custom color"
                onChange={(event) => pickColor(event.target.value)}
              />
            </label>
            <button
              className={tool === "picker" ? "color-picker-button color-picker-button--active" : "color-picker-button"}
              type="button"
              aria-label="Pick color from canvas"
              aria-pressed={tool === "picker"}
              aria-keyshortcuts="I"
              title="Pick color (I)"
              onClick={() => actions.current.togglePicker()}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="m12 2 5 5-2.5 2.5-1-1-7 7H3v-3.5l7-7-1-1zM6 15H3" />
              </svg>
            </button>
          </div>
        </section>
      ) : null}

      {dockPanel === "shape" ? (
        <section className="dock-popover dock-popover--shape" aria-label="Shape settings">
          <header>
            <span>Shape</span>
            <strong>
              {SHAPE_OPTIONS.find((option) => isShapeOptionActive(option, tool, shapeStyle))?.label ?? "Line"}
            </strong>
          </header>
          <div className="popover-shapes">
            {SHAPE_OPTIONS.map((option) => {
              const active = isShapeOptionActive(option, tool, shapeStyle);
              return (
                <button
                  key={option.key}
                  className={active ? "popover-option popover-option--active" : "popover-option"}
                  type="button"
                  aria-label={option.label}
                  aria-pressed={active}
                  aria-keyshortcuts={option.shortcut}
                  title={`${option.label} (${option.shortcut})`}
                  onClick={() => {
                    setTool(option.tool);
                    if (option.style) setShapeStyle(option.style);
                  }}
                >
                  {option.icon}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {dockPanel === "size" ? (
        <section className="dock-popover dock-popover--size" aria-label="Brush size">
          <header>
            <span>{tool === "erase" ? "Eraser" : "Brush"}</span>
            <strong>{brushSize} px</strong>
          </header>
          <div className="popover-sizes">
            {BRUSH_SIZES.map((size) => (
              <button
                key={size}
                className={size === brushSize ? "popover-option popover-option--active" : "popover-option"}
                type="button"
                aria-label={`${size} pixel ${tool === "erase" ? "eraser" : "brush"}`}
                aria-pressed={size === brushSize}
                title={`${size} px`}
                onClick={() => actions.current.chooseBrushSize(size)}
              >
                <span style={{ width: `${4 + size * 2}px`, height: `${4 + size * 2}px` }} />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {dockPanel === "more" ? (
        <section className="dock-popover dock-popover--more" aria-label="More canvas controls">
          <header>
            <span>Files</span>
            <strong>Canvas</strong>
          </header>
          <div className="popover-grid popover-grid--files popover-grid--icon-actions">
            <button
              type="button"
              aria-label="Import image"
              title="Import image"
              onClick={() => actions.current.openImportPicker()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 4v11m-4-4 4 4 4-4M5 18h14" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="Export canvas"
              title="Export canvas"
              onClick={() => actions.current.exportFullCanvas()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 15V4m-4 4 4-4 4 4M5 18h14" />
              </svg>
            </button>
            <button
              className="danger-option"
              type="button"
              aria-label="Clear canvas"
              title="Clear canvas (undoable)"
              onClick={() => actions.current.clearCanvas()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
              </svg>
            </button>
          </div>
          <label className="dock-toggle">
            <input type="checkbox" checked={autoFollow} onChange={(event) => setAutoFollow(event.target.checked)} />
            <span>Follow agent edits</span>
          </label>
        </section>
      ) : null}

      <div className="toolbar" role="toolbar" aria-label="Drawing tools">
        <button
          className={tool === "select" ? "dock-button dock-button--active" : "dock-button"}
          type="button"
          aria-label="Select"
          aria-pressed={tool === "select"}
          aria-keyshortcuts="M"
          title="Select (M)"
          onClick={() => actions.current.selectTool("select")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 3.5v16l4.2-4.2 3.1 5.2 3-1.8-3.1-5.1H19z" />
          </svg>
        </button>
        <button
          className={tool === "pan" ? "dock-button dock-button--active" : "dock-button"}
          type="button"
          aria-label="Hand tool"
          aria-pressed={tool === "pan"}
          aria-keyshortcuts="H"
          title="Hand (H)"
          onClick={() => actions.current.selectTool("pan")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10.05 4.575a1.575 1.575 0 1 0-3.15 0v3m3.15-3v-1.5a1.575 1.575 0 0 1 3.15 0v1.5m-3.15 0 .075 5.925m3.075.75V4.575m0 0a1.575 1.575 0 0 1 3.15 0V15M6.9 7.575a1.575 1.575 0 1 0-3.15 0v8.175a6.75 6.75 0 0 0 6.75 6.75h2.018a5.25 5.25 0 0 0 3.712-1.538l1.732-1.732a5.25 5.25 0 0 0 1.538-3.712l.003-2.024a.668.668 0 0 1 .198-.471 1.575 1.575 0 1 0-2.228-2.228 3.818 3.818 0 0 0-1.12 2.687M6.9 7.575V12m6.27 4.318A4.49 4.49 0 0 1 16.35 15m.002 0h-.002" />
          </svg>
        </button>
        <span className="dock-divider" aria-hidden="true" />
        <button
          className={`${tool === "paint" ? "dock-button dock-button--active" : "dock-button"} brush-dock-button`}
          type="button"
          aria-label="Draw"
          aria-pressed={tool === "paint"}
          aria-keyshortcuts="B"
          aria-haspopup="dialog"
          aria-expanded={dockPanel === "size"}
          title="Draw (B) — hold or right-click for size, [ and ] to resize"
          onClick={() => actions.current.selectBrushTool("paint")}
          {...brushSizeGestures}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m4 14 1.2-4.2L13 2l5 5-7.8 7.8L6 16zM12 3l5 5M4 14l2 2" />
          </svg>
          {brushSize > 1 ? <em>{brushSize}</em> : null}
        </button>
        <button
          className={`${tool === "erase" ? "dock-button dock-button--active" : "dock-button"} brush-dock-button`}
          type="button"
          aria-label="Erase"
          aria-pressed={tool === "erase"}
          aria-keyshortcuts="E"
          aria-haspopup="dialog"
          aria-expanded={dockPanel === "size"}
          title="Erase (E) — hold or right-click for size, [ and ] to resize"
          onClick={() => actions.current.selectBrushTool("erase")}
          {...brushSizeGestures}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m3.5 14 9.5-9.5 7 7-7.5 7.5H8.5zM8 9.5l7 7M12.5 19H21" />
          </svg>
          {brushSize > 1 ? <em>{brushSize}</em> : null}
        </button>
        <button
          className={tool === "fill" ? "dock-button dock-button--active" : "dock-button"}
          type="button"
          aria-label="Fill"
          aria-pressed={tool === "fill"}
          aria-keyshortcuts="G"
          title="Fill (G)"
          onClick={() => actions.current.selectTool("fill")}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m4 10 6-7 6 6-7 7zM7 6l6 6M15 14c0-1 1.5-3 1.5-3s1.5 2 1.5 3a1.5 1.5 0 0 1-3 0" />
          </svg>
        </button>
        <button
          className={isShapeTool(tool) || dockPanel === "shape" ? "dock-button dock-button--active" : "dock-button"}
          type="button"
          aria-label="Shapes"
          aria-pressed={isShapeTool(tool)}
          aria-expanded={dockPanel === "shape"}
          title="Shapes (L/R/O)"
          onClick={() => {
            if (!isShapeTool(tool)) setTool("line");
            setDockPanel((current) => (current === "shape" ? null : "shape"));
          }}
        >
          <Icon name="shapes" />
        </button>
        <button
          className={
            dockPanel === "color" || tool === "picker"
              ? "dock-button dock-button--active color-dock-button"
              : "dock-button color-dock-button"
          }
          type="button"
          aria-label="Colors"
          aria-expanded={dockPanel === "color"}
          title="Colors"
          onClick={() => setDockPanel((current) => (current === "color" ? null : "color"))}
        >
          <span style={{ backgroundColor: selectedColor }} />
        </button>
        <span className="dock-divider" aria-hidden="true" />
        <button
          className={symmetryEnabled && symmetry.horizontal ? "dock-button dock-button--active" : "dock-button"}
          type="button"
          disabled={!symmetryEnabled}
          aria-label="Mirror horizontally"
          aria-pressed={symmetry.horizontal}
          title={symmetryEnabled ? "Mirror across horizontal axis" : "Mirror is available with drawing tools"}
          onClick={() => actions.current.toggleSymmetry("horizontal")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12h18M7 8l5-5 5 5M7 16l5 5 5-5" />
          </svg>
        </button>
        <button
          className={symmetryEnabled && symmetry.vertical ? "dock-button dock-button--active" : "dock-button"}
          type="button"
          disabled={!symmetryEnabled}
          aria-label="Mirror vertically"
          aria-pressed={symmetry.vertical}
          title={symmetryEnabled ? "Mirror across vertical axis" : "Mirror is available with drawing tools"}
          onClick={() => actions.current.toggleSymmetry("vertical")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v18M8 7l-5 5 5 5M16 7l5 5-5 5" />
          </svg>
        </button>
        <span className="dock-divider" aria-hidden="true" />
        <button
          className={dockPanel === "more" ? "dock-button dock-button--active" : "dock-button"}
          type="button"
          aria-label="More controls"
          aria-expanded={dockPanel === "more"}
          title="More"
          onClick={() => setDockPanel((current) => (current === "more" ? null : "more"))}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="4" cy="10" r="1" />
            <circle cx="10" cy="10" r="1" />
            <circle cx="16" cy="10" r="1" />
          </svg>
        </button>
      </div>
    </div>
  );
});
