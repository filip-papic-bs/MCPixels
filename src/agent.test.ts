import assert from "node:assert/strict";
import test from "node:test";
import { CANVAS_SIZE, cellFromColor, cellIndex } from "./pixels.ts";
import { MAX_OPS, READ_OVERVIEW_BUDGET, AgentError, planDraw, readRegion, scaleForRegion } from "./agent/encode.ts";
import type { DrawInput, DrawPlan } from "./agent/encode.ts";

const emptyCells = () => new Uint32Array(CANVAS_SIZE * CANVAS_SIZE);

const paint = (cells: Uint32Array, x: number, y: number, color: string) => {
  cells[cellIndex(x, y)] = cellFromColor(color);
};

const applyPlan = (cells: Uint32Array, plan: DrawPlan) => {
  for (const { x, y, color } of plan.changes) {
    cells[cellIndex(x, y)] = color === "transparent" ? 0 : cellFromColor(color);
  }
};

const draw = (cells: Uint32Array, input: DrawInput) => {
  const plan = planDraw(cells, input);
  applyPlan(cells, plan);
  return plan;
};

test("a sprite survives draw, read and draw again unchanged", () => {
  const cells = emptyCells();
  draw(cells, {
    origin: [-4, -3],
    palette: { k: "#161616", r: "#ff5c35", w: "#f5f1e8" },
    rows: ["..kkkk..", ".krrrrk.", "kr.ww.rk", "krrrrrrk", ".kkkkkk."],
  });

  const read = readRegion(cells, null);
  assert.equal(read.scale, 1, "a small sprite reads back at exact scale");
  assert.deepEqual(read.origin, [-4, -3]);
  assert.deepEqual(read.size, [8, 5]);

  const fresh = emptyCells();
  draw(fresh, { origin: read.origin, palette: read.palette, rows: read.rows });
  assert.deepEqual(fresh, cells, "read output fed back into draw reproduces the canvas");
});

test('"." composites and "-" is the only way to erase', () => {
  const cells = emptyCells();
  for (let y = 0; y < 2; y += 1) for (let x = 0; x < 4; x += 1) paint(cells, x, y, "#2d7ff9");

  const overlay = draw(cells, { origin: [0, 0], palette: { r: "#ff5c35" }, rows: ["r.-r"] });
  assert.equal(overlay.painted, 2);
  assert.equal(overlay.erased, 1);
  assert.equal(cells[cellIndex(1, 0)], cellFromColor("#2d7ff9"), '"." left the cell alone');
  assert.equal(cells[cellIndex(2, 0)], 0, '"-" erased the cell');

  // Stamping over existing art must never scrub what it does not paint: the
  // safe failure is a missed erase, not a destroyed sprite.
  const patch = draw(cells, { origin: [0, 1], palette: { r: "#ff5c35" }, rows: ["r..r"] });
  assert.equal(patch.painted, 2);
  assert.equal(patch.erased, 0);
  assert.equal(cells[cellIndex(1, 1)], cellFromColor("#2d7ff9"), "the art underneath survived");
  assert.equal(cells[cellIndex(3, 1)], cellFromColor("#ff5c35"));
});

test("off-canvas cells are clipped and short rows only warn", () => {
  const cells = emptyCells();
  const clipped = draw(cells, {
    origin: [508, 508],
    palette: { k: "#161616" },
    rows: Array.from({ length: 8 }, () => "kkkkkkkk"),
  });
  assert.equal(clipped.painted, 16, "only the 4x4 corner is on canvas");
  assert.equal(clipped.clipped, 48);

  const ragged = draw(emptyCells(), {
    origin: [0, 0],
    palette: { k: "#161616" },
    rows: ["kkkk", "kk", "kkkk"],
  });
  assert.equal(ragged.painted, 10);
  assert.equal(ragged.warnings.length, 1);
  assert.match(ragged.warnings[0], /row 2/);
});

test("ops draw shapes and later ops win", () => {
  const cells = emptyCells();
  const plan = draw(cells, { ops: "c #161616;rect -2 -2 2 2 f;c #ff5c35;line -5 0 5 0" });
  // 25 filled cells, plus 11 on the line, of which 5 overlap the rectangle.
  assert.equal(plan.painted, 31);
  assert.equal(cells[cellIndex(0, 0)], cellFromColor("#ff5c35"), "the line was drawn after the rectangle");
  assert.equal(cells[cellIndex(-2, -2)], cellFromColor("#161616"));
  assert.equal(cells[cellIndex(5, 0)], cellFromColor("#ff5c35"));
});

test("bucket sees the shapes drawn earlier in the same call", () => {
  const cells = emptyCells();
  const plan = draw(cells, {
    palette: { k: "#161616", b: "#2d7ff9" },
    ops: "c k;rect -5 -5 5 5;c b;bucket 0 0",
  });
  // An 11x11 outline is 40 cells; the fill stays inside its 9x9 interior.
  assert.equal(plan.painted, 121);
  assert.equal(cells[cellIndex(0, 0)], cellFromColor("#2d7ff9"));
  assert.equal(cells[cellIndex(6, 0)], 0, "the fill did not escape the rectangle");
});

test("a call that fails to parse changes nothing at all", () => {
  const cells = emptyCells();
  paint(cells, 0, 0, "#2d7ff9");
  const before = cells.slice();
  assert.throws(() => planDraw(cells, { ops: "c #161616;px 4 4;rekt 1 2 3 4" }), AgentError);
  assert.deepEqual(cells, before);
});

test("parse errors name the problem and how to fix it", () => {
  const cells = emptyCells();
  const message = (input: DrawInput) => {
    try {
      planDraw(cells, input);
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };

  assert.equal(
    message({ ops: "rekt 1 2 3 4" }),
    'ops op 1 "rekt": unknown op (use c, px, line, rect, ellipse, bucket, recolor)',
  );
  assert.equal(
    message({ ops: "px 0 0" }),
    'ops op 1 "px": no color set yet — start with "c <palette character or #rrggbb>"',
  );
  assert.equal(message({ ops: "c #161616;line 1 2 3" }), 'ops op 2 "line": needs 4 integers (x0 y0 x1 y1), got 3');
  assert.equal(
    message({ origin: [0, 0], palette: { k: "#161616" }, rows: ["kk", "kq"] }),
    'rows: row 2 uses "q", which is not in the palette',
  );
  assert.equal(
    message({ origin: [0, 0], palette: { ".": "#161616" }, rows: ["."] }),
    'palette key "." is reserved (. skips a cell, - erases one)',
  );
});

test("mirror reflects a write across both canvas axes", () => {
  const cells = emptyCells();
  const plan = draw(cells, { ops: "c #161616;px 2 5", mirror: "both" });
  assert.equal(plan.painted, 4);
  assert.deepEqual(
    plan.changes.map(({ x, y }) => [x, y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    [
      [-3, -6],
      [-3, 5],
      [2, -6],
      [2, 5],
    ],
  );
});

test("large regions downscale deterministically and keep every painted block", () => {
  assert.equal(scaleForRegion(256, 256), 4);
  assert.equal(scaleForRegion(65, 20), 2);
  assert.equal(scaleForRegion(64, 64), 1);

  const cells = emptyCells();
  for (let y = -128; y <= 127; y += 1) for (let x = -128; x <= 127; x += 1) paint(cells, x, y, "#161616");

  // An omitted region can span the whole canvas, so it gets the tighter budget.
  const overview = readRegion(cells, null);
  assert.ok(overview.rows.length <= READ_OVERVIEW_BUDGET);
  assert.equal(overview.exact, false, "a downscaled read never claims to be exact");
  assert.deepEqual(readRegion(cells, null), overview, "the same canvas always reads identically");

  // A region the agent named keeps the larger budget.
  const named = readRegion(cells, { minX: -128, minY: -128, maxX: 127, maxY: 127 });
  assert.equal(named.scale, 4);
  assert.equal(named.rows.length, 64);
  assert.equal(named.rows[0].length, 64);

  // A block holding a single painted pixel resolves to that pixel's color.
  const sparse = emptyCells();
  paint(sparse, 3, 3, "#ff5c35");
  const zoomed = readRegion(sparse, { minX: 0, minY: 0, maxX: 127, maxY: 127 });
  assert.equal(zoomed.scale, 2);
  assert.equal(zoomed.rows[1][1], "a");
  assert.deepEqual(zoomed.palette, { a: "#ff5c35" });
});

test("a read is only exact when both geometry and color survive", () => {
  const cells = emptyCells();
  // 70 distinct colors inside a region small enough to need no downscaling:
  // the geometry is lossless but the palette is not, so exact must be false.
  for (let index = 0; index < 70; index += 1) {
    paint(cells, index % 10, Math.floor(index / 10), `#${(index * 3 + 1).toString(16).padStart(6, "0")}`);
  }
  const read = readRegion(cells, { minX: 0, minY: 0, maxX: 9, maxY: 6 });
  assert.equal(read.scale, 1, "no downscaling was needed");
  assert.ok(read.folded > 0, "some colors were folded");
  assert.equal(read.exact, false, "scale 1 alone must not be read as lossless");
  assert.match(String(read.note), /folded/);
});

test("recolor swaps one color for another inside a region", () => {
  const cells = emptyCells();
  draw(cells, { ops: "c #ff5c35;rect 0 0 4 4 f" });

  const plan = draw(cells, { ops: "recolor #ff5c35 #2d7ff9 0 0 2 2" });
  assert.equal(plan.painted, 9, "only the nine cells inside the region changed");
  assert.equal(cells[cellIndex(0, 0)], cellFromColor("#2d7ff9"));
  assert.equal(cells[cellIndex(4, 4)], cellFromColor("#ff5c35"), "outside the region is untouched");

  // It sees earlier ops in the same call, and can recolor to nothing.
  const erased = draw(cells, { ops: "c #45b86b;rect 20 20 21 21 f;recolor #45b86b - 20 20 20 21" });
  assert.equal(erased.painted, 2, "only the column that was not erased stayed painted");
  assert.equal(cells[cellIndex(20, 20)], 0);
  assert.equal(cells[cellIndex(21, 20)], cellFromColor("#45b86b"));

  assert.throws(() => planDraw(cells, { ops: "recolor - #161616 0 0 4 4" }), /"from" cannot be "-"/);

  // Clamping each edge on its own would collapse a wholly off-canvas rectangle
  // onto the nearest real column and recolor live pixels there.
  const offCanvas = planDraw(cells, { ops: "recolor #ff5c35 #2d7ff9 600 0 700 10" });
  assert.equal(offCanvas.painted, 0, "a region past the edge touches nothing");
});

test("mirrored geometry is visible to a later bucket in the same call", () => {
  const cells = emptyCells();
  // Half a closed box, mirrored. If the fill ran against the unmirrored overlay
  // it would escape through the open side and flood the canvas.
  const plan = draw(cells, {
    palette: { k: "#161616", b: "#2d7ff9" },
    ops: "c k;line -5 -5 -5 5;line -5 -5 -1 -5;line -5 5 -1 5;c b;bucket -3 0",
    mirror: "left-right",
  });
  assert.deepEqual(plan.bounds, { minX: -5, minY: -5, maxX: 4, maxY: 5 });
  assert.equal(cells[cellIndex(0, 0)], cellFromColor("#2d7ff9"), "the fill crossed the mirror axis");
  assert.equal(cells[cellIndex(20, 0)], 0, "and did not escape the box");
});

test("a runaway call is refused before it allocates", () => {
  const cells = emptyCells();
  // 128 large filled rectangles, quadrupled by four-way mirroring, would queue
  // tens of millions of objects if the budget were only checked at the end.
  const ops = Array.from({ length: MAX_OPS - 1 }, () => "rect -111 -111 111 111 f").join(";");
  assert.throws(
    () => planDraw(cells, { ops: `c #161616;${ops}`, mirror: "both" }),
    (error: Error) => error instanceof AgentError && /limit is 1200000/.test(error.message),
  );
});

test("a cheaper way to write the call is offered, never imposed", () => {
  const symmetric: DrawInput = {
    origin: [-8, 0],
    palette: { k: "#161616" },
    rows: Array.from({ length: 4 }, () => "k".repeat(16)),
  };
  const plain = planDraw(emptyCells(), symmetric);
  assert.equal(plain.painted, 64, "the call still does exactly what was asked");
  assert.match(String(plain.hint), /left-right/);

  // Suppression is per-suggestion, not blanket: a call that already mirrors is
  // never told to mirror, but may still be told a rect would be cheaper.
  const alreadyMirrored = planDraw(emptyCells(), { ...symmetric, mirror: "left-right" });
  assert.doesNotMatch(String(alreadyMirrored.hint), /mirror:/);

  // A rows call that spells out a solid block is worth a nudge...
  const spelled = planDraw(emptyCells(), {
    origin: [0, 0],
    palette: { k: "#161616" },
    rows: Array.from({ length: 9 }, () => "k".repeat(10)),
  });
  assert.match(String(spelled.hint), /^the solid block at \(0, 0\) to \(9, 8\) is one op/);

  // ...but telling someone who already used rect to use rect is noise.
  const already = planDraw(emptyCells(), { ops: "c #161616;rect 0 0 9 8 f" });
  assert.equal(already.hint, undefined);
});
