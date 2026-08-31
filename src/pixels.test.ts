import assert from "node:assert/strict";
import test from "node:test";
import {
  CANVAS_MIN,
  CANVAS_SIZE,
  applyPixelAction,
  applySymmetry,
  brushStamp,
  cellFromColor,
  cellIndex,
  createPixelStore,
  decodeCells,
  detectPixelGrid,
  encodeCells,
  floodFill,
  pixelsInShape,
  pixelsOnLine,
  rasterizeImportSource,
  stepBrushSize,
} from "./pixels.ts";

const emptyCells = () => new Uint32Array(CANVAS_SIZE * CANVAS_SIZE);

const paint = (cells: Uint32Array, x: number, y: number, color: string) => {
  cells[cellIndex(x, y)] = cellFromColor(color);
};

test("run-length encoding round-trips a canvas", () => {
  const cells = emptyCells();
  for (let x = -8; x <= 8; x += 1) paint(cells, x, 0, "#ff5c35");
  for (let y = -4; y <= 4; y += 1) paint(cells, 3, y, "#2d7ff9");
  paint(cells, CANVAS_MIN, CANVAS_MIN, "#161616");

  const encoded = encodeCells(cells);
  assert.ok(encoded);
  assert.deepEqual(encoded.palette, ["#161616", "#2d7ff9", "#ff5c35"]);
  assert.ok(encoded.runs.length < 4_096);
  assert.deepEqual(decodeCells(encoded.palette, encoded.runs), cells);
});

test("undo and redo restore the exact cells around a move", () => {
  const store = createPixelStore(emptyCells());
  applyPixelAction(store, { type: "paint", changes: [{ x: 0, y: 0, color: "#ff5c35" }] });
  const painted = store.cells.slice();

  applyPixelAction(store, {
    type: "move",
    from: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    changes: [{ x: 5, y: 5, color: "#ff5c35" }],
    selectionBefore: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    selectionAfter: { minX: 5, minY: 5, maxX: 5, maxY: 5 },
  });
  const moved = store.cells.slice();
  assert.equal(store.cells[cellIndex(0, 0)], 0);
  assert.equal(store.cells[cellIndex(5, 5)], cellFromColor("#ff5c35"));

  applyPixelAction(store, { type: "undo" });
  assert.deepEqual(store.cells, painted);
  applyPixelAction(store, { type: "redo" });
  assert.deepEqual(store.cells, moved);
  assert.equal(store.undoStack.at(-1)?.selectionAfter?.minX, 5);
});

test("flood fill stays inside a closed border", () => {
  const cells = emptyCells();
  for (let at = -3; at <= 3; at += 1) {
    paint(cells, at, -3, "#161616");
    paint(cells, at, 3, "#161616");
    paint(cells, -3, at, "#161616");
    paint(cells, 3, at, "#161616");
  }

  const { changes } = floodFill(cells, { x: 0, y: 0 }, "#45b86b");
  assert.equal(changes.length, 25);
  assert.ok(changes.every(({ x, y }) => x > -3 && x < 3 && y > -3 && y < 3));
  assert.deepEqual(floodFill(cells, { x: -3, y: -3 }, "#161616"), { changes: [], reason: "same-color" });
});

test("shapes trace outlines and mirror across both axes", () => {
  const outline = pixelsInShape("rectangle", { x: 0, y: 0 }, { x: 3, y: 2 }, "outline", "#2d7ff9", {
    horizontal: false,
    vertical: false,
  });
  assert.equal(outline?.length, 10);
  assert.ok(outline?.every(({ x, y }) => x === 0 || x === 3 || y === 0 || y === 2));

  const mirrored = applySymmetry([{ x: 2, y: 5, color: "#2d7ff9" }], { horizontal: true, vertical: true });
  assert.deepEqual(
    mirrored?.map(({ x, y }) => [x, y]).sort(),
    [[-3, -6], [-3, 5], [2, -6], [2, 5]].sort(),
  );
});

test("brush stamps square footprints and dedupes along a stroke", () => {
  assert.deepEqual(brushStamp([{ x: 4, y: -2 }], 1, "#161616"), [{ x: 4, y: -2, color: "#161616" }]);

  const single = brushStamp([{ x: 0, y: 0 }], 3, "#161616");
  assert.equal(single.length, 9);
  assert.ok(single.every(({ x, y }) => x >= -1 && x <= 1 && y >= -1 && y <= 1));

  const stroke = brushStamp(pixelsOnLine({ x: 0, y: 0 }, { x: 4, y: 0 }, "#161616"), 3, "#161616");
  assert.equal(stroke.length, 21);
  assert.equal(new Set(stroke.map(({ x, y }) => `${x},${y}`)).size, stroke.length);

  assert.equal(stepBrushSize(1, -1), 1);
  assert.equal(stepBrushSize(8, 1), 8);
  assert.equal(stepBrushSize(4, 1), 6);
});

test("upscaled pixel art is detected and rasterized back to its art size", () => {
  const art = 8;
  const pitch = 5;
  const size = art * pitch;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = (Math.floor(x / pitch) + Math.floor(y / pitch)) % 2 === 0 ? 245 : 22;
      const at = (y * size + x) * 4;
      data[at] = value;
      data[at + 1] = value;
      data[at + 2] = value;
      data[at + 3] = 255;
    }
  }

  const grid = detectPixelGrid(data, size, size);
  assert.equal(grid.columns, art);
  assert.equal(grid.rows, art);
  assert.ok(Math.abs(grid.pitch - pitch) < 0.25);

  const changes = rasterizeImportSource({ name: "art", data, width: size, height: size, ...grid }, art, art);
  assert.equal(changes.length, art * art);
  assert.equal(changes[0].color, "#f5f5f5");
  assert.equal(changes[1].color, "#161616");
});
