import assert from "node:assert/strict";
import test from "node:test";
import { CANVAS_SIZE, cellFromColor, cellIndex } from "./pixels.ts";
import {
  MAX_OPS,
  MAX_POLY_POINTS,
  READ_OVERVIEW_BUDGET,
  AgentError,
  decodeRleRow,
  encodeRleRow,
  planDraw,
  readRegion,
  scaleForRegion,
} from "./agent/encode.ts";
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
    'ops op 1 "rekt": unknown op (use c, px, line, poly, path, rect, ellipse, fill, bucket, recolor)',
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

  // Past MAX_RLE_CELLS an exact run-length read is not even attempted, so this
  // is the shape of art that still has to be downscaled however flat it is.
  const cells = emptyCells();
  for (let y = -300; y <= 299; y += 1) for (let x = -300; x <= 299; x += 1) paint(cells, x, y, "#161616");

  // An omitted region can span the whole canvas, so it gets the tighter budget.
  const overview = readRegion(cells, null);
  assert.ok(overview.rows.length <= READ_OVERVIEW_BUDGET);
  assert.equal(overview.format, "chars");
  assert.equal(overview.exact, false, "a downscaled read never claims to be exact");
  assert.deepEqual(readRegion(cells, null), overview, "the same canvas always reads identically");

  // A region the agent named keeps the larger budget.
  const named = readRegion(cells, { minX: -300, minY: -300, maxX: 299, maxY: 299 });
  assert.equal(named.scale, 10);
  assert.equal(named.rows.length, 60);
  assert.equal(named.rows[0].length, 60);

  // A block holding a single painted pixel resolves to that pixel's color.
  // Centred, so the region is not clipped back to the canvas and stays over the
  // cap: sparse art compresses beautifully and would otherwise read exactly.
  const sparse = emptyCells();
  paint(sparse, 3, 3, "#ff5c35");
  const zoomed = readRegion(sparse, { minX: -300, minY: -300, maxX: 299, maxY: 299 });
  assert.equal(zoomed.scale, 10);
  assert.equal(zoomed.rows[30][30], "a");
  assert.deepEqual(zoomed.palette, { a: "#ff5c35" });
});

test("run-length rows decode, encode and survive a round trip", () => {
  assert.equal(decodeRleRow("12k8r.", "row"), "kkkkkkkkkkkkrrrrrrrr.");
  assert.equal(decodeRleRow("k", "row"), "k");
  assert.equal(decodeRleRow("", "row"), "");
  assert.equal(decodeRleRow("3-2.", "row"), "---..", "the reserved characters run like any other");

  assert.equal(encodeRleRow("kkkkkkkkkkkkrrrrrrrr."), "12k8r.");
  assert.equal(encodeRleRow(""), "");
  assert.equal(encodeRleRow("krw"), "krw", "single cells cost no count");

  // The property that matters: for any row of plain cells, encode then decode is
  // identity. Digits are absent by construction — they cannot be palette keys in
  // rle, which is exactly why a count can never be mistaken for a cell.
  for (const row of ["", "k", "....", "krkrkrkr", "aB.cD-", "k".repeat(300), "kk", "kkr", `${"ab".repeat(40)}300`]) {
    const plain = row.replace(/\d/g, "z");
    assert.equal(decodeRleRow(encodeRleRow(plain), "row"), plain, `round trip of "${plain.slice(0, 20)}"`);
  }

  assert.throws(() => decodeRleRow("12", "row"), /has no character after it/);
  assert.throws(() => decodeRleRow("0k", "row"), /count of 0/);
  assert.throws(() => decodeRleRow("2000k", "row"), /wider than the canvas/);
});

test("a large scene fits one rle call and reads back exactly", () => {
  const cells = emptyCells();
  const palette = { s: "#2d7ff9", g: "#45b86b", k: "#161616" };

  // The 200x200 that needed two calls as plain characters: 40,000 cells, well
  // past MAX_ROWS_CELLS, but a few thousand characters as runs.
  const rows: string[] = [];
  for (let row = 0; row < 200; row += 1) {
    if (row < 120) rows.push("200s");
    else if (row < 180) rows.push("200g");
    else rows.push("80g40k80g");
  }
  const source = JSON.stringify(rows).length;
  assert.ok(source < 4_000, `the whole scene is ${source} characters of rows`);

  const plan = draw(cells, { origin: [-100, -100], palette, rows, format: "rle" });
  assert.equal(plan.painted, 40_000, "one call, one undo step, forty thousand cells");
  assert.equal(plan.clipped, 0);
  assert.deepEqual(plan.bounds, { minX: -100, minY: -100, maxX: 99, maxY: 99 });

  // And it comes back exactly, which plain characters could not manage.
  const read = readRegion(cells, { minX: -100, minY: -100, maxX: 99, maxY: 99 });
  assert.equal(read.format, "rle");
  assert.equal(read.exact, true);
  assert.equal(read.scale, 1);
  assert.deepEqual(read.size, [200, 200]);

  const fresh = emptyCells();
  draw(fresh, { origin: read.origin, palette: read.palette, rows: read.rows, format: read.format });
  assert.deepEqual(fresh, cells, "an exact read fed straight back reproduces the canvas");
});

test("rle rejects what it cannot represent", () => {
  const cells = emptyCells();

  assert.throws(
    () => planDraw(cells, { origin: [0, 0], palette: { "1": "#161616" }, rows: ["3."], format: "rle" }),
    /cannot be a digit/,
    "a digit key would be unreadable as anything but a count",
  );
  // The same palette is fine as plain characters, so nothing that worked breaks.
  assert.equal(planDraw(cells, { origin: [0, 0], palette: { "1": "#161616" }, rows: ["111"] }).painted, 3);

  assert.throws(() => planDraw(cells, { origin: [0, 0], rows: ["3q"], format: "rle" }), /not in the palette/);
  assert.throws(() => planDraw(cells, { origin: [0, 0], rows: ["3."], format: "chars2" }), /"chars" or "rle"/);

  // Plain characters over the area cap point at the encoding that would fit.
  assert.throws(
    () => planDraw(cells, { origin: [0, 0], palette: { k: "#161616" }, rows: Array(200).fill("k".repeat(200)) }),
    /format:"rle"/,
  );
});

test("poly fills the shapes that used to need hand rasterizing", () => {
  const cells = emptyCells();

  // A roof: the filled triangle nobody wants to work out row by row.
  const roof = draw(cells, { ops: "c #ff5c35;poly 0 10 5 0 10 10 f" });
  assert.deepEqual(roof.bounds, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  assert.equal(cells[cellIndex(5, 1)], cellFromColor("#ff5c35"), "just under the apex is inside");
  assert.equal(cells[cellIndex(5, 10)], cellFromColor("#ff5c35"), "the base is drawn");
  assert.equal(cells[cellIndex(0, 0)], 0, "the corner outside the slope is not");
  assert.equal(cells[cellIndex(10, 0)], 0);

  // Every row of a triangle is a contiguous span, and the rows widen downward.
  for (let y = 1; y <= 10; y += 1) {
    const row: number[] = [];
    for (let x = 0; x <= 10; x += 1) if (cells[cellIndex(x, y)] !== 0) row.push(x);
    assert.ok(row.length > 0, `row ${y} has pixels`);
    assert.equal(row.at(-1)! - row[0] + 1, row.length, `row ${y} is one unbroken span`);
  }

  // Outline only leaves the middle empty, and closes the loop.
  const hollow = emptyCells();
  draw(hollow, { ops: "c #161616;poly 0 0 8 0 8 8 0 8" });
  assert.equal(hollow[cellIndex(4, 0)], cellFromColor("#161616"), "the given edges are drawn");
  assert.equal(hollow[cellIndex(0, 4)], cellFromColor("#161616"), "and the edge back to the first point");
  assert.equal(hollow[cellIndex(4, 4)], 0, "an unfilled poly is hollow");

  // path walks the same points but never closes: the last edge is missing.
  const open = emptyCells();
  draw(open, { ops: "c #161616;path 0 0 8 0 8 8 0 8" });
  assert.equal(open[cellIndex(4, 0)], cellFromColor("#161616"), "the given edges are still drawn");
  assert.equal(open[cellIndex(8, 4)], cellFromColor("#161616"));
  assert.equal(open[cellIndex(4, 8)], cellFromColor("#161616"));
  assert.equal(open[cellIndex(0, 4)], 0, "but nothing closes it back to the start");
});

test("poly and path refuse what they cannot draw", () => {
  const cells = emptyCells();

  assert.throws(() => planDraw(cells, { ops: "c #161616;poly 0 0 5 5" }), /at least 3 points/);
  assert.throws(() => planDraw(cells, { ops: "c #161616;path 0 0" }), /at least 2 points/);
  assert.throws(() => planDraw(cells, { ops: "c #161616;poly 0 0 5 5 9" }), /odd number of values/);
  assert.throws(() => planDraw(cells, { ops: "poly 0 0 5 5 9 9" }), /no color set yet/);

  const many = Array.from({ length: MAX_POLY_POINTS + 1 }, (_, at) => `${at} ${at}`).join(" ");
  assert.throws(() => planDraw(cells, { ops: `c #161616;poly ${many}` }), /exceeds the limit/);

  // A huge filled polygon is priced by its bounding box before it is generated.
  assert.throws(() => planDraw(cells, { ops: "c #161616;poly -300 -300 300 -300 0 300 f" }), /the limit is/);
});

test("fill lays down patterns a row at a time would not", () => {
  const cells = emptyCells();

  const checker = draw(cells, { ops: "c #161616;fill 0 0 3 3 checker #161616 #f5f1e8" });
  assert.equal(checker.painted, 16, "every cell in the region is written");
  assert.equal(cells[cellIndex(0, 0)], cellFromColor("#161616"));
  assert.equal(cells[cellIndex(1, 0)], cellFromColor("#f5f1e8"), "neighbours alternate");
  assert.equal(cells[cellIndex(0, 1)], cellFromColor("#f5f1e8"));
  assert.equal(cells[cellIndex(1, 1)], cellFromColor("#161616"));

  // Squares bigger than one cell, and continuous across the origin.
  const blocks = emptyCells();
  draw(blocks, { ops: "c #161616;fill -4 -4 3 3 checker #161616 #f5f1e8 2" });
  assert.equal(blocks[cellIndex(0, 0)], blocks[cellIndex(1, 1)], "a 2x2 square is one color");
  assert.notEqual(blocks[cellIndex(0, 0)], blocks[cellIndex(2, 0)], "the next square differs");
  assert.equal(blocks[cellIndex(-1, -1)], blocks[cellIndex(-2, -2)], "and it keeps tiling past zero");

  // Dither density is monotonic: more percent, more of the second color.
  const counts = [0, 25, 50, 75, 100].map((percent) => {
    const scratch = emptyCells();
    draw(scratch, { ops: `c #161616;fill 0 0 15 15 dither #161616 #f5f1e8 ${percent}` });
    let second = 0;
    for (let y = 0; y <= 15; y += 1) {
      for (let x = 0; x <= 15; x += 1) if (scratch[cellIndex(x, y)] === cellFromColor("#f5f1e8")) second += 1;
    }
    return second;
  });
  assert.deepEqual(counts, [0, 64, 128, 192, 256], "each step adds a quarter of the 256 cells");

  assert.throws(() => planDraw(cells, { ops: "c #161616;fill 0 0 3 3 swirl #161616 #f5f1e8" }), /not a fill mode/);
  assert.throws(() => planDraw(cells, { ops: "c #161616;fill 0 0 3 3 dither #161616 #f5f1e8 120" }), /0 to 100/);
  assert.throws(() => planDraw(cells, { ops: "c #161616;fill 0 0 3 3 checker #161616 #f5f1e8 0" }), /size must be/);
  assert.throws(() => planDraw(cells, { ops: "c #161616;fill 0 0 300 300 checker #161616 #f5f1e8" }), /the limit is/);
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
