import {
  CANVAS_MAX,
  CANVAS_MIN,
  MAX_EXPORT_SCALE,
  MAX_SHAPE_PIXELS,
  boundsForOrigin,
  captureRegion,
  clampOriginToCanvas,
  intersectCanvas,
  paintedBounds,
  placeRegion,
  transformRegion,
} from "../pixels.ts";
import type { PixelChange, SelectionBounds } from "../pixels.ts";
import {
  AgentError,
  MAX_OPS,
  MAX_OPS_LENGTH,
  MAX_PALETTE,
  MAX_PX_PAIRS,
  MAX_ROWS,
  MAX_ROWS_CELLS,
  MAX_ROW_LENGTH,
  READ_ALPHABET,
  READ_BUDGET,
  READ_OVERVIEW_BUDGET,
  planDraw,
  readPoint,
  readRect,
  readRegion,
} from "./encode.ts";
import type { EditorController } from "./controller.ts";
import type { ModelContext } from "../webmcp";

export const AGENT_TOOL_COUNT = 6;
export const MAX_DUPLICATES = 64;
export const MAX_EDIT_STEPS = 20;

const AGENT_LIMITS = {
  canvas: [CANVAS_MIN, CANVAS_MIN, CANVAS_MAX, CANVAS_MAX],
  maxCellsPerDraw: MAX_ROWS_CELLS,
  maxRows: MAX_ROWS,
  maxRowLength: MAX_ROW_LENGTH,
  maxPaletteEntries: MAX_PALETTE,
  maxOps: MAX_OPS,
  maxOpsLength: MAX_OPS_LENGTH,
  maxPxPairs: MAX_PX_PAIRS,
  maxShapePixels: MAX_SHAPE_PIXELS,
  exactReadSize: READ_BUDGET,
  exactReadColors: READ_ALPHABET.length,
  overviewReadSize: READ_OVERVIEW_BUDGET,
  maxDuplicates: MAX_DUPLICATES,
  maxEditSteps: MAX_EDIT_STEPS,
  maxExportScale: MAX_EXPORT_SCALE,
} as const;

const RECT_SCHEMA = {
  type: "array",
  items: { type: "integer", minimum: CANVAS_MIN, maximum: CANVAS_MAX },
  minItems: 4,
  maxItems: 4,
} as const;

const POINT_SCHEMA = {
  type: "array",
  items: { type: "integer", minimum: CANVAS_MIN, maximum: CANVAS_MAX },
  minItems: 2,
  maxItems: 2,
} as const;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Resolves an optional region argument, falling back to everything painted. */
function regionOrArt(controller: EditorController, value: unknown, label: string): SelectionBounds {
  if (value === undefined || value === null) {
    const art = paintedBounds(controller.getCells());
    if (!art) throw new AgentError("the canvas is empty, so there is nothing to use as a default region");
    return art;
  }
  const region = intersectCanvas(readRect(value, label));
  if (!region) throw new AgentError(`that region is entirely off the ${CANVAS_MIN}..${CANVAS_MAX} canvas`);
  return region;
}

/**
 * Resolves the rectangle an op works on. An explicit region wins, so an agent
 * never has to depend on whatever the person happened to have selected.
 */
function opRegion(controller: EditorController, value: unknown): SelectionBounds {
  if (value !== undefined && value !== null) {
    const region = intersectCanvas(readRect(value, '"region"'));
    if (!region) throw new AgentError(`that region is entirely off the ${CANVAS_MIN}..${CANVAS_MAX} canvas`);
    return region;
  }
  const selection = controller.getSelection();
  if (!selection) throw new AgentError('pass "region" ([x0,y0,x1,y1]), or select something first');
  return selection;
}

function regionsOverlap(a: SelectionBounds, b: SelectionBounds) {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

function requirePoint(value: unknown, op: string) {
  if (value === undefined || value === null) throw new AgentError(`selection ${op} needs "to" ([x,y] top-left target)`);
  return readPoint(value, '"to"');
}

export async function registerAgentTools(
  modelContext: ModelContext,
  controller: EditorController,
  options: { signal: AbortSignal },
): Promise<number> {
  const { signal } = options;

  /** Wraps a handler so the status pill pulses while the tool runs. */
  const run =
    <T>(work: (input: Record<string, unknown>, options: { signal: AbortSignal }) => T | Promise<T>) =>
    async (input: Record<string, unknown>, options: { signal: AbortSignal }) => {
      controller.setWorking(true);
      try {
        return await work(input, options);
      } finally {
        controller.setWorking(false);
      }
    };

  await Promise.all([
    modelContext.registerTool(
      {
        name: "draw_pixel_art",
        title: "Draw pixel art",
        description:
          `Draw editable pixel art on the live canvas; x and y run ${CANVAS_MIN}..${CANVAS_MAX}, y downward. ` +
          'rows place one-character palette entries from origin; "." keeps a cell and "-" erases it. ' +
          'ops are ";"-separated: c COLOR; px x y...; line x0 y0 x1 y1; rect/ellipse x0 y0 x1 y1 [f]; bucket x y; recolor from to x0 y0 x1 y1. ' +
          'COLOR is a palette key, hex, or "-"; f fills. Ops use absolute coordinates. ' +
          "Rows run first and later writes win. Off-canvas clips. One call is one undo step; invalid input changes nothing.",
        inputSchema: {
          type: "object",
          properties: {
            origin: { ...POINT_SCHEMA, description: "Canvas position of the top-left cell of rows." },
            palette: {
              type: "object",
              description: `Character to color, e.g. {"k":"#161616","r":"#ff5c35"}. Up to ${MAX_PALETTE} entries. "." and "-" are reserved.`,
              additionalProperties: { type: "string", pattern: "^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$" },
            },
            rows: {
              type: "array",
              description:
                `Picture rows, top to bottom. At most ${MAX_ROWS} rows of ${MAX_ROW_LENGTH} characters, ` +
                `and at most ${MAX_ROWS_CELLS} cells per call counted as widest row x row count — so ${MAX_ROW_LENGTH}x${MAX_ROW_LENGTH} is over the limit. ` +
                "Beyond that, send flat areas as ops and split the detail across calls.",
              items: { type: "string", maxLength: MAX_ROW_LENGTH },
              maxItems: MAX_ROWS,
            },
            ops: {
              type: "string",
              description:
                `Command string, up to ${MAX_OPS} ops and ${MAX_OPS_LENGTH} characters. ` +
                `px takes up to ${MAX_PX_PAIRS} x y pairs; one line, rect or ellipse covers up to ${MAX_SHAPE_PIXELS} pixels. ` +
                "Ops are not counted against the rows cell limit, so large flat geometry is cheapest here.",
              maxLength: MAX_OPS_LENGTH,
            },
            mirror: {
              type: "string",
              enum: ["left-right", "top-bottom", "both"],
              description: "Also mirror everything this call draws across the canvas center.",
            },
          },
          additionalProperties: false,
        },
        execute: run(async (input: Record<string, unknown>) => {
          const plan = planDraw(controller.getCells(), input);
          if (plan.changes.length === 0) {
            // Both can be true at once, so the note reports every reason.
            const reasons: string[] = [];
            if (plan.unchanged > 0) reasons.push(`${plural(plan.unchanged, "cell")} already had that color`);
            if (plan.clipped > 0) reasons.push(`${plural(plan.clipped, "write")} landed off the canvas`);
            const note =
              reasons.length > 0
                ? `nothing changed: ${reasons.join(", and ")}`
                : "that call asked for no writes at all";
            return {
              painted: 0,
              erased: 0,
              clipped: plan.clipped,
              bounds: null,
              ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
              note,
            };
          }
          controller.apply({ type: "paint", changes: plan.changes, historyGroup: controller.beginGroup() });

          const where = plan.bounds ? ` around (${plan.bounds.minX}, ${plan.bounds.minY})` : "";
          const what =
            plan.erased > 0
              ? `Agent drew ${plural(plan.painted, "pixel")} and erased ${plan.erased}${where}.`
              : `Agent drew ${plural(plan.painted, "pixel")}${where}.`;
          controller.notify(what, { kind: "draw", bounds: plan.bounds ?? undefined });

          return {
            painted: plan.painted,
            erased: plan.erased,
            clipped: plan.clipped,
            bounds: plan.bounds ? [plan.bounds.minX, plan.bounds.minY, plan.bounds.maxX, plan.bounds.maxY] : null,
            ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
            ...(plan.hint ? { hint: plan.hint } : {}),
          };
        }),
      },
      { signal },
    ),

    modelContext.registerTool(
      {
        name: "read_canvas",
        title: "Read the canvas",
        description:
          "Read the canvas back in the same {origin, palette, rows} format draw_pixel_art accepts, so you can read, edit the rows and draw them straight back. " +
          'Here "." marks an empty cell, but drawn back it preserves the destination — use "-" to erase. ' +
          `Omit region for an overview of everything painted, downscaled to at most ${READ_OVERVIEW_BUDGET} characters a side; name a region for native resolution up to ${READ_BUDGET}x${READ_BUDGET}, larger areas are block-downscaled. ` +
          `"exact" is true only when the region is at most ${READ_BUDGET}x${READ_BUDGET} AND holds at most ${READ_ALPHABET.length} distinct colors — rarer colors fold into the nearest kept one. ` +
          "When it is false the rows are an approximation: read smaller regions in turn before relying on them. " +
          'Every read also reports the state you need to plan with — "painted"/"empty"/"colors" counts that stay exact however coarse the rows are, ' +
          'plus "art", "selection", "view", "history" and the full "limits" table. Read once before a large draw and you will not have to learn a cap by hitting it.',
        inputSchema: {
          type: "object",
          properties: {
            region: {
              ...RECT_SCHEMA,
              description:
                "[x0, y0, x1, y1] rectangle to read, inclusive, corners in any order. Defaults to everything painted.",
            },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: run(async (input: Record<string, unknown>) => {
          const cells = controller.getCells();
          const requested =
            input.region === undefined || input.region === null ? null : readRect(input.region, '"region"');
          const result = readRegion(cells, requested);
          const art = paintedBounds(cells);
          const selection = controller.getSelection();

          controller.notify(
            result.rows.length === 0
              ? "Agent looked at the canvas and found it empty."
              : `Agent looked at a ${result.size[0]} by ${result.size[1]} area at (${result.origin[0]}, ${result.origin[1]}).`,
            { kind: "view", bounds: requested ?? art ?? undefined },
          );

          const history = controller.getHistory();

          return {
            ...result,
            art: art ? [art.minX, art.minY, art.maxX, art.maxY] : null,
            paintedTotal: controller.countPainted(),
            selection: selection ? [selection.minX, selection.minY, selection.maxX, selection.maxY] : null,
            view: controller.getViewport(),
            history: { undo: history.undoDepth, redo: history.redoDepth },
            limits: AGENT_LIMITS,
          };
        }),
      },
      { signal },
    ),

    modelContext.registerTool(
      {
        name: "selection",
        title: "Selection",
        description:
          "Rearrange existing art without resending pixels. region defaults to the visible selection. " +
          'duplicate stamps a copy at absolute "to" ("times" repeats the offset for a row); move also clears the source; erase clears region; ' +
          "flip-left-right, flip-top-bottom and rotate transform in place (rotate is 90\u00b0 clockwise, swapping w/h); " +
          'copy/cut use the app clipboard and paste stamps at "to"; set/dismiss only change the marquee. ' +
          "Pixel-changing ops are one undo step; set, dismiss and copy add none.",
        inputSchema: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: [
                "set",
                "dismiss",
                "erase",
                "duplicate",
                "move",
                "copy",
                "cut",
                "paste",
                "flip-left-right",
                "flip-top-bottom",
                "rotate",
              ],
            },
            region: {
              ...RECT_SCHEMA,
              description: "[x0, y0, x1, y1], corners in any order. Defaults to the rectangle the person has selected.",
            },
            to: {
              ...POINT_SCHEMA,
              description: "Absolute [x, y] canvas position for the target's top-left corner, not an offset.",
            },
            times: {
              type: "integer",
              minimum: 1,
              maximum: MAX_DUPLICATES,
              description: "duplicate only: how many copies, each repeating the offset of the first. Default 1.",
            },
          },
          required: ["op"],
          additionalProperties: false,
        },
        execute: run(async (input: Record<string, unknown>) => {
          const op = String(input.op ?? "");
          const cells = controller.getCells();
          const reply = (pixels: number, extra?: Record<string, unknown>) => {
            const selection = controller.getSelection();
            return {
              op,
              selection: selection ? [selection.minX, selection.minY, selection.maxX, selection.maxY] : null,
              pixels,
              ...extra,
            };
          };

          if (op === "set") {
            if (input.region === undefined) throw new AgentError('selection set needs "region" ([x0,y0,x1,y1])');
            const bounds = opRegion(controller, input.region);
            controller.setSelection(bounds);
            const painted = controller.countPainted(bounds);
            controller.notify(
              `Agent selected ${bounds.maxX - bounds.minX + 1} by ${bounds.maxY - bounds.minY + 1} at (${bounds.minX}, ${bounds.minY}).`,
              { kind: "select", bounds },
            );
            return reply(painted);
          }

          if (op === "dismiss") {
            controller.setSelection(null);
            controller.notify("Agent dismissed the selection.", { kind: "select" });
            return reply(0);
          }

          if (op === "erase") {
            const bounds = opRegion(controller, input.region);
            const painted = controller.countPainted(bounds);
            controller.apply({ type: "clear-area", bounds });
            controller.notify(`Agent erased ${plural(painted, "pixel")} inside the selection.`, {
              kind: "draw",
              bounds,
            });
            return reply(painted);
          }

          if (op === "copy" || op === "cut") {
            const bounds = opRegion(controller, input.region);
            const captured = captureRegion(cells, bounds);
            controller.setClipboard(captured);
            if (op === "cut") controller.apply({ type: "clear-area", bounds });
            controller.notify(
              `Agent ${op === "cut" ? "cut" : "copied"} ${plural(captured.pixels.length, "pixel")} from a ${captured.width} by ${captured.height} selection.`,
              { kind: "select", bounds },
            );
            return reply(captured.pixels.length);
          }

          if (op === "paste") {
            const clip = controller.getClipboard();
            if (!clip) throw new AgentError("nothing has been copied yet — use selection copy or cut first");
            const requested = input.to === undefined || input.to === null ? clip.origin : readPoint(input.to, '"to"');
            const origin = clampOriginToCanvas(requested, clip.width, clip.height);
            const changes = placeRegion(clip, origin);
            if (changes.length > 0) {
              controller.apply({ type: "paint", changes, historyGroup: controller.beginGroup() });
            }
            const bounds = boundsForOrigin(origin, clip.width, clip.height);
            controller.setSelection(bounds);
            controller.notify(`Agent pasted ${plural(changes.length, "pixel")} at (${origin.x}, ${origin.y}).`, {
              kind: "draw",
              bounds,
            });
            return reply(changes.length);
          }

          if (op === "duplicate") {
            const bounds = opRegion(controller, input.region);
            const captured = captureRegion(cells, bounds);
            const first = requirePoint(input.to, "duplicate");
            const times = input.times === undefined ? 1 : Number(input.times);
            if (!Number.isSafeInteger(times) || times < 1 || times > MAX_DUPLICATES) {
              throw new AgentError(`"times" must be a whole number from 1 to ${MAX_DUPLICATES}`);
            }
            // Each further copy repeats the offset of the first, so a row of
            // sprites is one call and one undo step instead of N of each.
            const step = { x: first.x - bounds.minX, y: first.y - bounds.minY };
            if (step.x === 0 && step.y === 0) {
              throw new AgentError('"to" is the region\'s own corner, so there is nothing to copy');
            }

            // Each target is checked *after* clamping, against the source and
            // every earlier copy. Checking the step alone is not enough: a copy
            // clamped back onto the canvas can slide into what it just missed.
            const changes: PixelChange[] = [];
            const placed: SelectionBounds[] = [bounds];
            let last = bounds;
            for (let copy = 1; copy <= times; copy += 1) {
              const origin = clampOriginToCanvas(
                { x: bounds.minX + step.x * copy, y: bounds.minY + step.y * copy },
                captured.width,
                captured.height,
              );
              const target = boundsForOrigin(origin, captured.width, captured.height);
              const clash = placed.find((earlier) => regionsOverlap(earlier, target));
              if (clash) {
                throw new AgentError(
                  clash === bounds
                    ? `duplicate would overwrite its own source: a copy lands on (${target.minX}, ${target.minY}), inside the region. Pick a "to" further away, or use move.`
                    : `copy ${copy} lands on copy ${placed.length - 1} at (${target.minX}, ${target.minY}) — the canvas edge pushed them together. Use fewer copies or a smaller step.`,
                );
              }
              placed.push(target);
              changes.push(...placeRegion(captured, origin));
              last = target;
            }
            if (changes.length > 0) {
              controller.apply({ type: "paint", changes, historyGroup: controller.beginGroup() });
            }
            controller.setSelection(last);
            controller.notify(
              times === 1
                ? `Agent duplicated ${plural(changes.length, "pixel")} to (${first.x}, ${first.y}).`
                : `Agent placed ${times} copies of a ${captured.width} by ${captured.height} region.`,
              { kind: "draw", bounds: last },
            );
            return reply(changes.length);
          }

          if (op === "move") {
            const bounds = opRegion(controller, input.region);
            const captured = captureRegion(cells, bounds);
            const origin = clampOriginToCanvas(requirePoint(input.to, "move"), captured.width, captured.height);
            const after = boundsForOrigin(origin, captured.width, captured.height);
            controller.apply({
              type: "move",
              from: bounds,
              changes: placeRegion(captured, origin),
              selectionBefore: bounds,
              selectionAfter: after,
            });
            controller.setSelection(after);
            controller.notify(`Agent moved the selection to (${origin.x}, ${origin.y}).`, {
              kind: "select",
              bounds: after,
            });
            return reply(captured.pixels.length);
          }

          if (op === "flip-left-right" || op === "flip-top-bottom" || op === "rotate") {
            const bounds = opRegion(controller, input.region);
            const captured = captureRegion(cells, bounds);
            const transformed = transformRegion(captured, op);
            // A rotate swaps width and height, so a tall region near the right
            // edge would spill off-canvas and silently lose pixels.
            const origin = clampOriginToCanvas(
              { x: bounds.minX, y: bounds.minY },
              transformed.width,
              transformed.height,
            );
            const after = boundsForOrigin(origin, transformed.width, transformed.height);
            controller.apply({
              type: "move",
              from: bounds,
              changes: placeRegion(transformed, origin),
              selectionBefore: bounds,
              selectionAfter: after,
            });
            controller.setSelection(after);
            controller.notify(
              op === "rotate"
                ? "Agent rotated the selection."
                : `Agent flipped the selection ${op === "flip-left-right" ? "left to right" : "top to bottom"}.`,
              { kind: "select", bounds: after },
            );
            return reply(captured.pixels.length);
          }

          throw new AgentError(`unknown selection op "${op}"`);
        }),
      },
      { signal },
    ),

    modelContext.registerTool(
      {
        name: "edit",
        title: "Undo, redo, clear",
        description:
          "Step through the shared edit history — the person's edits and yours are one timeline — or wipe the canvas. op=undo, op=redo, or op=clear-canvas, which erases everything and is itself undoable.",
        inputSchema: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["undo", "redo", "clear-canvas"] },
            steps: {
              type: "integer",
              minimum: 1,
              maximum: MAX_EDIT_STEPS,
              description: "How many undo or redo steps. Default 1.",
            },
          },
          required: ["op"],
          additionalProperties: false,
        },
        execute: run(async (input: Record<string, unknown>) => {
          const op = String(input.op ?? "");
          const finish = (applied: number, text: string, bounds?: SelectionBounds) => {
            const history = controller.getHistory();
            const selection = controller.getSelection();
            controller.notify(text, { kind: "history", bounds });
            return {
              op,
              applied,
              history: { undo: history.undoDepth, redo: history.redoDepth },
              selection: selection ? [selection.minX, selection.minY, selection.maxX, selection.maxY] : null,
            };
          };

          if (op === "clear-canvas") {
            const cleared = controller.countPainted();
            const outcome = controller.apply({ type: "clear" });
            controller.setSelection(null);
            if (!outcome.changed) return finish(0, "Agent found the canvas already empty.");
            return finish(1, `Agent cleared the canvas (${plural(cleared, "pixel")}).`);
          }

          if (op !== "undo" && op !== "redo") throw new AgentError(`unknown edit op "${op}"`);

          const steps = input.steps === undefined ? 1 : Number(input.steps);
          if (!Number.isSafeInteger(steps) || steps < 1 || steps > MAX_EDIT_STEPS) {
            throw new AgentError(`"steps" must be a whole number from 1 to ${MAX_EDIT_STEPS}`);
          }

          let applied = 0;
          let touched: SelectionBounds | undefined;
          for (let step = 0; step < steps; step += 1) {
            // The marquee is restored from the patch, matching the editor's own
            // undo so agent and human history stay one timeline.
            const patch = op === "undo" ? controller.peekUndo() : controller.peekRedo();
            const outcome = controller.apply({ type: op });
            if (!outcome.changed) break;
            applied += 1;
            if (outcome.bounds) touched = outcome.bounds;
            if (patch) {
              const marquee = op === "undo" ? patch.selectionBefore : patch.selectionAfter;
              if (marquee !== undefined) controller.setSelection(marquee);
            }
          }

          if (applied === 0) {
            return finish(0, `Agent had nothing left to ${op}.`);
          }
          return finish(applied, `Agent ${op === "undo" ? "undid" : "redid"} ${plural(applied, "edit")}.`, touched);
        }),
      },
      { signal },
    ),

    modelContext.registerTool(
      {
        name: "view",
        title: "Move the view",
        description:
          "Frame a canvas region for the person without changing any pixels. Omit region to frame all painted art. Edits already bring themselves on screen, so this is only for navigation the person asked for.",
        inputSchema: {
          type: "object",
          properties: {
            region: {
              ...RECT_SCHEMA,
              description: "[x0, y0, x1, y1] to frame, corners in any order. Defaults to everything painted.",
            },
          },
          additionalProperties: false,
        },
        execute: run(async (input: Record<string, unknown>) => {
          const bounds = regionOrArt(controller, input.region, '"region"');
          if (controller.isPersonDrawing()) {
            throw new AgentError(
              "the person is drawing right now — moving the view would break their stroke; try again in a moment",
            );
          }
          const view = controller.frameRegion(bounds);
          controller.notify(`Agent framed (${bounds.minX}, ${bounds.minY}) to (${bounds.maxX}, ${bounds.maxY}).`, {
            kind: "view",
            bounds,
          });
          return { view, framed: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY] };
        }),
      },
      { signal },
    ),

    modelContext.registerTool(
      {
        name: "export_pixel_art",
        title: "Export pixel art as PNG",
        description:
          "Save part of the canvas as a PNG in the person's downloads. Defaults to everything painted. scale turns each canvas pixel into a scale by scale block and is reduced automatically so the file stays within 4096 pixels per side.",
        inputSchema: {
          type: "object",
          properties: {
            region: {
              ...RECT_SCHEMA,
              description: "[x0, y0, x1, y1] to export, corners in any order. Defaults to everything painted.",
            },
            scale: {
              type: "integer",
              minimum: 1,
              maximum: MAX_EXPORT_SCALE,
              description: "Pixels per cell. Default 8.",
            },
          },
          additionalProperties: false,
        },
        execute: run(async (input: Record<string, unknown>, { signal: calling }) => {
          const bounds = regionOrArt(controller, input.region, '"region"');
          const scale = input.scale === undefined ? 8 : Number(input.scale);
          if (!Number.isSafeInteger(scale) || scale < 1 || scale > MAX_EXPORT_SCALE) {
            throw new AgentError(`"scale" must be a whole number from 1 to ${MAX_EXPORT_SCALE}`);
          }
          const saved = await controller.exportPng(bounds, scale, calling);
          controller.notify(`Agent exported a ${saved.width} by ${saved.height} PNG.`, { kind: "export", bounds });
          return {
            file: saved.file,
            size: [saved.width, saved.height],
            region: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY],
            // The requested scale is reduced to keep the file within limits.
            scale: saved.scale,
          };
        }),
      },
      { signal },
    ),
  ]);

  return AGENT_TOOL_COUNT;
}
