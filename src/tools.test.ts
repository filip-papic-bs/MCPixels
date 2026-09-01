import assert from "node:assert/strict";
import test from "node:test";
import {
  CANVAS_MAX,
  CANVAS_MIN,
  CANVAS_SIZE,
  applyPixelAction,
  cellFromColor,
  cellIndex,
  countPaintedCells,
  createPixelStore,
} from "./pixels.ts";
import type { CopiedSelection, SelectionBounds } from "./pixels.ts";
import { AGENT_TOOL_COUNT, registerAgentTools } from "./agent/tools.ts";
import { MAX_ROWS_CELLS, READ_BUDGET } from "./agent/encode.ts";
import type { EditorController } from "./agent/controller.ts";
import type { ModelContext, WebMcpTool } from "./webmcp.ts";

function fakeEditor() {
  const store = createPixelStore(new Uint32Array(CANVAS_SIZE * CANVAS_SIZE));
  let selection: SelectionBounds | null = null;
  let clipboard: CopiedSelection | null = null;
  let group = 0;
  let drawing = false;
  const notices: string[] = [];
  const exported: { width: number; height: number }[] = [];

  const controller: EditorController = {
    canvas: { size: CANVAS_SIZE, minX: CANVAS_MIN, minY: CANVAS_MIN, maxX: CANVAS_MAX, maxY: CANVAS_MAX },
    getCells: () => store.cells,
    countPainted: (bounds) => countPaintedCells(store.cells, bounds),
    getHistory: () => ({ version: 0, undoDepth: store.undoStack.length, redoDepth: store.redoStack.length }),
    peekUndo: () => store.undoStack.at(-1),
    peekRedo: () => store.redoStack.at(-1),
    beginGroup: () => (group += 1),
    apply: (action) => applyPixelAction(store, action),
    getViewport: () => ({ x: 0, y: 0, zoom: 22 }),
    getViewSize: () => ({ width: 800, height: 600 }),
    frameRegion: () => ({ x: 0, y: 0, zoom: 22 }),
    isPersonDrawing: () => drawing,
    getSelection: () => selection,
    setSelection: (next) => {
      selection = next;
    },
    getClipboard: () => clipboard,
    setClipboard: (clip) => {
      clipboard = clip;
    },
    exportPng: async (bounds, scale) => {
      const width = (bounds.maxX - bounds.minX + 1) * scale;
      const height = (bounds.maxY - bounds.minY + 1) * scale;
      exported.push({ width, height });
      return { file: `mcpixels-${width}x${height}.png`, width, height, scale };
    },
    notify: (text) => notices.push(text),
    setWorking: () => {},
  };

  return {
    store,
    controller,
    notices,
    exported,
    getSelection: () => selection,
    getClipboard: () => clipboard,
    setDrawing: (value: boolean) => {
      drawing = value;
    },
  };
}

async function registerTools(controller: EditorController) {
  const tools = new Map<string, WebMcpTool>();
  const modelContext: ModelContext = {
    registerTool: async (tool) => {
      tools.set(tool.name, tool);
    },
  };
  const count = await registerAgentTools(modelContext, controller, { signal: new AbortController().signal });
  const call = (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    assert.ok(tool, `${name} is registered`);
    return tool.execute(input, { signal: new AbortController().signal }) as Promise<Record<string, unknown>>;
  };
  return { tools, count, call };
}

test("the six tools register and describe themselves within budget", async () => {
  const { controller } = fakeEditor();
  const { tools, count } = await registerTools(controller);

  assert.equal(count, AGENT_TOOL_COUNT);
  assert.deepEqual([...tools.keys()].sort(), [
    "draw_pixel_art",
    "edit",
    "export_pixel_art",
    "read_canvas",
    "selection",
    "view",
  ]);
  assert.equal(tools.get("read_canvas")?.annotations?.readOnlyHint, true);

  const serialized = [...tools.values()]
    .map((tool) => tool.name + tool.description + JSON.stringify(tool.inputSchema))
    .join("");
  assert.ok(serialized.length < 7_600, `tool surface is ${serialized.length} characters`);
});

test("an agent can draw, read back, rearrange and export", async () => {
  const editor = fakeEditor();
  const { call } = await registerTools(editor.controller);

  const drawn = await call("draw_pixel_art", {
    origin: [0, 0],
    palette: { k: "#161616", r: "#ff5c35" },
    rows: ["kkk", "krk", "kkk"],
  });
  assert.equal(drawn.painted, 9);
  assert.deepEqual(drawn.bounds, [0, 0, 2, 2]);
  assert.equal(editor.store.undoStack.length, 1, "one call is one undo step");

  const read = await call("read_canvas");
  assert.deepEqual(read.origin, [0, 0]);
  assert.deepEqual(read.size, [3, 3]);
  assert.equal(read.scale, 1);
  assert.deepEqual(read.rows, ["aaa", "aba", "aaa"]);
  assert.deepEqual(read.art, [0, 0, 2, 2]);

  await call("selection", { op: "set", region: [0, 0, 2, 2] });
  await call("selection", { op: "copy" });
  await call("selection", { op: "paste", to: [10, 10] });
  assert.equal(editor.store.cells[cellIndex(11, 11)], cellFromColor("#ff5c35"), "the copy landed intact");

  await call("selection", { op: "move", to: [20, 20] });
  assert.equal(editor.store.cells[cellIndex(11, 11)], 0, "the moved pixels left their old home");
  assert.equal(editor.store.cells[cellIndex(21, 21)], cellFromColor("#ff5c35"));

  const exported = await call("export_pixel_art", { region: [0, 0, 2, 2], scale: 4 });
  assert.deepEqual(exported.size, [12, 12]);
  assert.deepEqual(editor.exported.at(-1), { width: 12, height: 12 });

  assert.ok(editor.notices.length >= 6, "each action told the person what happened");
});

test("a read reports the limits and exact counts even when the rows are coarse", async () => {
  const editor = fakeEditor();
  const { call } = await registerTools(editor.controller);

  await call("draw_pixel_art", { ops: "c #161616;rect -50 -50 49 49 f;c #ff5c35;rect -10 -10 9 9 f" });

  const read = await call("read_canvas", { region: [-50, -50, 49, 49] });
  assert.equal(read.exact, false, "a 100x100 region cannot come back exactly");
  assert.ok(read.scale > 1);

  assert.equal(read.painted, 10_000, "every painted cell is counted, not every block");
  assert.equal(read.empty, 0);
  assert.deepEqual(read.colors, { "#161616": 9_600, "#ff5c35": 400 });
  assert.equal(read.distinctColors, 2);
  assert.equal(read.paintedTotal, 10_000);

  assert.equal(read.limits.maxCellsPerDraw, MAX_ROWS_CELLS);
  assert.equal(read.limits.exactReadSize, READ_BUDGET);
  assert.deepEqual(read.history, { undo: 1, redo: 0 });

  const half = await call("read_canvas", { region: [-50, -50, 49, -1] });
  assert.equal(half.painted, 5_000, "counts follow the region, not the whole canvas");
  assert.equal(half.paintedTotal, 10_000);
});

test("undo walks several steps and stops when the history runs out", async () => {
  const editor = fakeEditor();
  const { call } = await registerTools(editor.controller);

  await call("draw_pixel_art", { ops: "c #161616;px 0 0" });
  await call("draw_pixel_art", { ops: "c #161616;px 1 0" });
  await call("draw_pixel_art", { ops: "c #161616;px 2 0" });

  const undone = await call("edit", { op: "undo", steps: 2 });
  assert.equal(undone.applied, 2);
  assert.equal(editor.store.cells[cellIndex(0, 0)], cellFromColor("#161616"));
  assert.equal(editor.store.cells[cellIndex(1, 0)], 0);

  const tooMany = await call("edit", { op: "undo", steps: 5 });
  assert.equal(tooMany.applied, 1, "reports what it managed, rather than failing");

  const empty = await call("edit", { op: "undo" });
  assert.equal(empty.applied, 0);
});

test("region ops work without a selection and stay on canvas", async () => {
  const editor = fakeEditor();
  const { call } = await registerTools(editor.controller);

  await call("draw_pixel_art", { origin: [0, 0], palette: { r: "#ff5c35" }, rows: ["rr", "rr"] });

  const copied = await call("selection", { op: "duplicate", region: [0, 0, 1, 1], to: [40, 40] });
  assert.equal(copied.pixels, 4);
  assert.equal(editor.store.cells[cellIndex(0, 0)], cellFromColor("#ff5c35"), "the original stayed put");
  assert.equal(editor.store.cells[cellIndex(40, 40)], cellFromColor("#ff5c35"));
  assert.deepEqual(copied.selection, [40, 40, 41, 41], "the new copy is selected");
  assert.equal(editor.getClipboard(), null, "duplicate leaves the clipboard alone");

  await assert.rejects(
    call("selection", { op: "duplicate", region: [0, 0, 1, 1], to: [1, 1] }),
    /overwrite its own source/,
  );

  const before = editor.store.undoStack.length;
  const row = await call("selection", { op: "duplicate", region: [0, 0, 1, 1], to: [4, 0], times: 3 });
  assert.equal(row.pixels, 12, "three copies of four pixels");
  assert.equal(editor.store.undoStack.length, before + 1, "and one undo step for the lot");
  for (const x of [4, 8, 12]) {
    assert.equal(editor.store.cells[cellIndex(x, 0)], cellFromColor("#ff5c35"), `copy at x=${x}`);
  }
  assert.deepEqual(row.selection, [12, 0, 13, 1], "the last copy ends up selected");

  await call("draw_pixel_art", { origin: [500, 20], palette: { g: "#45b86b" }, rows: ["gggggggggg"] });
  await assert.rejects(
    call("selection", { op: "duplicate", region: [500, 20, 509, 20], to: [511, 20] }),
    /overwrite its own source/,
  );
  await assert.rejects(
    call("selection", { op: "duplicate", region: [480, 20, 489, 20], to: [495, 20], times: 4 }),
    /lands on copy/,
  );

  await call("draw_pixel_art", { origin: [CANVAS_MAX - 1, 0], palette: { b: "#2d7ff9" }, rows: Array(40).fill("bb") });
  const rotated = await call("selection", { op: "rotate", region: [CANVAS_MAX - 1, 0, CANVAS_MAX, 39] });
  const after = rotated.selection as number[];
  assert.ok(after[2] <= CANVAS_MAX && after[3] <= CANVAS_MAX, `selection ${after} stayed on canvas`);
  assert.equal(
    countPaintedCells(editor.store.cells, { minX: after[0], minY: after[1], maxX: after[2], maxY: after[3] }),
    80,
  );
});

test("results reflect writes made earlier in the same call", async () => {
  const editor = fakeEditor();
  const { call } = await registerTools(editor.controller);
  await call("draw_pixel_art", { origin: [0, 0], palette: { k: "#161616" }, rows: ["kk", "kk"] });

  const set = await call("selection", { op: "set", region: [0, 0, 1, 1] });
  assert.deepEqual(set.selection, [0, 0, 1, 1]);

  const moved = await call("selection", { op: "move", to: [10, 10] });
  assert.deepEqual(moved.selection, [10, 10, 11, 11]);

  const undone = await call("edit", { op: "undo" });
  assert.deepEqual(undone.history, { undo: 1, redo: 1 });
});

test("view refuses to move the canvas out from under a live stroke", async () => {
  const editor = fakeEditor();
  const { call } = await registerTools(editor.controller);
  await call("draw_pixel_art", { origin: [0, 0], palette: { k: "#161616" }, rows: ["kk"] });

  editor.setDrawing(true);
  await assert.rejects(call("view"), /drawing right now/);

  editor.setDrawing(false);
  const framed = await call("view");
  assert.deepEqual(framed.framed, [0, 0, 1, 0]);
});

test("tools refuse impossible input with a sentence the agent can act on", async () => {
  const editor = fakeEditor();
  const { call } = await registerTools(editor.controller);

  await assert.rejects(call("selection", { op: "move", to: [4, 4] }), /pass "region"/);
  await assert.rejects(call("selection", { op: "paste" }), /nothing has been copied/);
  await assert.rejects(call("view"), /canvas is empty/);
  await assert.rejects(call("draw_pixel_art", { ops: "px 0 0" }), /no color set yet/);
  await assert.rejects(call("edit", { op: "undo", steps: 99 }), /1 to 20/);
  await assert.rejects(
    call("draw_pixel_art", { origin: [0, 0], palette: { k: "#161616" }, rows: ["kk"], ops: 42 }),
    /"ops" must be a string/,
  );
  assert.equal(countPaintedCells(editor.store.cells), 0, "nothing was drawn by any failed call");
});
