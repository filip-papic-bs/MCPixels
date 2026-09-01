import {
  CANVAS_MAX,
  CANVAS_MIN,
  EMPTY_CELL,
  MAX_SHAPE_PIXELS,
  cellFromColor,
  cellIndex,
  cellX,
  cellY,
  colorFromCell,
  intersectCanvas,
  floodFill,
  isOnCanvas,
  paintedBounds,
  pixelsInShape,
  pixelsOnLine,
} from "../pixels.ts";
import type { PixelChange, SelectionBounds } from "../pixels.ts";

export const MAX_OPS = 128;
export const MAX_PX_PAIRS = 500;
export const MAX_ROWS = 256;
export const MAX_ROW_LENGTH = 256;
export const MAX_ROWS_CELLS = 32_768;
export const MAX_CALL_CELLS = 1_200_000;
export const MAX_PALETTE = 64;
export const OP_COORDINATE_LIMIT = 1024;
export const READ_BUDGET = 64;
export const READ_OVERVIEW_BUDGET = 48;
export const READ_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const HINT_MIN_CELLS = 64;
export const READ_HISTOGRAM = 16;

export const MAX_RLE_ROWS = 1024;
export const MAX_RLE_ROW_CELLS = 1024;
export const MAX_RLE_CELLS = 262_144;
export const MAX_RLE_SOURCE_LENGTH = 1024;
export const READ_RLE_BUDGET = 6_000;

const HEX_COLOR = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
const WHOLE_NUMBER = /^-?\d+$/;

export class AgentError extends Error {}

function fail(message: string): never {
  throw new AgentError(message);
}

export function normalizeHex(color: string) {
  const value = color.slice(1).toLowerCase();
  const full = value.length === 3 ? value.replace(/./g, (digit) => digit + digit) : value;
  return `#${full}`;
}

const ERASE = EMPTY_CELL;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export function readRect(value: unknown, label: string): SelectionBounds {
  if (!Array.isArray(value) || value.length !== 4) {
    fail(`${label} must be [x0, y0, x1, y1], four whole numbers`);
  }
  const numbers = (value as unknown[]).map((entry, at) => {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry)) {
      fail(`${label}[${at}] must be a whole number`);
    }
    return entry as number;
  });
  const [x0, y0, x1, y1] = numbers;
  return {
    minX: Math.min(x0, x1),
    minY: Math.min(y0, y1),
    maxX: Math.max(x0, x1),
    maxY: Math.max(y0, y1),
  };
}

export function readPoint(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length !== 2) fail(`${label} must be [x, y]`);
  const [x, y] = value as unknown[];
  if (typeof x !== "number" || !Number.isSafeInteger(x) || typeof y !== "number" || !Number.isSafeInteger(y)) {
    fail(`${label} must be [x, y], two whole numbers`);
  }
  return { x: x as number, y: y as number };
}

export function parsePalette(input: unknown): Map<string, number> {
  const palette = new Map<string, number>();
  if (input === undefined || input === null) return palette;
  if (typeof input !== "object" || Array.isArray(input)) fail(`"palette" must be an object of character to color`);

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === "." || key === "-") fail(`palette key "${key}" is reserved (. skips a cell, - erases one)`);
    if (key.length !== 1) fail(`palette key "${key}" must be a single character`);
    if (typeof value !== "string" || !HEX_COLOR.test(value)) {
      fail(`palette color "${String(value)}" must be #rgb or #rrggbb`);
    }
    if (palette.size === MAX_PALETTE) {
      fail(`palette has more than ${MAX_PALETTE} entries; the limit is ${MAX_PALETTE}`);
    }
    palette.set(key, cellFromColor(normalizeHex(value)));
  }
  return palette;
}

// ---------------------------------------------------------------------------
// Run-length rows
// ---------------------------------------------------------------------------

const isDigit = (char: string) => char >= "0" && char <= "9";

/**
 * Expands one run-length row into plain characters. A run is an optional count
 * followed by exactly one character, so `12k8r.` is twelve k, eight r, one dot.
 * Digits can never be palette keys here, which is what keeps the two apart.
 */
export function decodeRleRow(source: string, where: string): string {
  if (source.length > MAX_RLE_SOURCE_LENGTH) {
    fail(`${where}: ${source.length} characters exceeds the limit of ${MAX_RLE_SOURCE_LENGTH} for a run-length row`);
  }
  const parts: string[] = [];
  let cells = 0;
  let at = 0;
  while (at < source.length) {
    let digits = "";
    while (at < source.length && isDigit(source[at])) {
      digits += source[at];
      at += 1;
    }
    if (at >= source.length) {
      fail(`${where}: run count "${digits}" has no character after it — write ${digits} then the palette key`);
    }
    const char = source[at];
    at += 1;
    const count = digits === "" ? 1 : Number(digits);
    if (count === 0) fail(`${where}: a run count of 0 draws nothing — leave the run out instead`);
    // Checked before expanding, so an absurd count cannot allocate first.
    if (cells + count > MAX_RLE_ROW_CELLS) {
      fail(`${where}: the row decodes to more than ${MAX_RLE_ROW_CELLS} cells, wider than the canvas`);
    }
    cells += count;
    parts.push(char.repeat(count));
  }
  return parts.join("");
}

/** Encodes plain characters back into runs. `kkkkk` becomes `5k`. */
export function encodeRleRow(chars: string): string {
  let out = "";
  let at = 0;
  while (at < chars.length) {
    const char = chars[at];
    let run = 1;
    while (at + run < chars.length && chars[at + run] === char) run += 1;
    out += run === 1 ? char : `${run}${char}`;
    at += run;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Polygons and patterns
// ---------------------------------------------------------------------------

export const MAX_POLY_POINTS = 64;
export const MAX_CHECKER_SIZE = 256;

type Point = { x: number; y: number };

/**
 * Even-odd scanline fill. Sampling at each pixel's own centre with a half-open
 * comparison is what makes a vertex count once rather than twice; the outline is
 * drawn over the top regardless, which covers the degenerate spans this misses.
 */
export function pixelsInPolygon(points: Point[]): Point[] {
  const inside: Point[] = [];
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.y < top) top = point.y;
    if (point.y > bottom) bottom = point.y;
  }

  const crossings: number[] = [];
  for (let y = top; y <= bottom; y += 1) {
    crossings.length = 0;
    for (let index = 0; index < points.length; index += 1) {
      const from = points[index];
      const to = points[(index + 1) % points.length];
      if (from.y <= y === to.y <= y) continue;
      crossings.push(from.x + ((y - from.y) / (to.y - from.y)) * (to.x - from.x));
    }
    crossings.sort((a, b) => a - b);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const start = Math.ceil(crossings[pair]);
      const end = Math.floor(crossings[pair + 1]);
      for (let x = start; x <= end; x += 1) inside.push({ x, y });
    }
  }
  return inside;
}

// A 4x4 ordered dither. Bitwise & keeps the index non-negative for negative
// coordinates, so a pattern is continuous across the origin.
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** True when this cell should take the second color at the given density. */
export function ditherPicksSecond(x: number, y: number, percent: number) {
  return (BAYER_4[y & 3][x & 3] + 0.5) / 16 < percent / 100;
}

/** True when this cell falls on a "first color" square of the checkerboard. */
export function checkerPicksFirst(x: number, y: number, size: number) {
  const column = Math.floor(x / size);
  const row = Math.floor(y / size);
  return (((column + row) % 2) + 2) % 2 === 0;
}

// ---------------------------------------------------------------------------
// The draw planner
// ---------------------------------------------------------------------------

export type DrawInput = {
  origin?: unknown;
  palette?: unknown;
  rows?: unknown;
  format?: unknown;
  ops?: unknown;
  mirror?: unknown;
};

export type RowFormat = "chars" | "rle";

export function readFormat(value: unknown): RowFormat {
  if (value === undefined || value === null) return "chars";
  if (value === "chars" || value === "rle") return value;
  fail(`"format" must be "chars" or "rle"`);
}

function readMirror(mirror: unknown) {
  if (mirror === undefined || mirror === null) return { flipX: false, flipY: false };
  if (mirror === "left-right") return { flipX: true, flipY: false };
  if (mirror === "top-bottom") return { flipX: false, flipY: true };
  if (mirror === "both") return { flipX: true, flipY: true };
  fail(`"mirror" must be "left-right", "top-bottom" or "both"`);
}

export type DrawPlan = {
  changes: PixelChange[];
  painted: number;
  erased: number;
  unchanged: number;
  clipped: number;
  bounds: SelectionBounds | null;
  warnings: string[];
  hint?: string;
};

type Write = { x: number; y: number; value: number };

/**
 * Plans a whole `draw` call in memory and throws before anything is applied, so
 * a call either lands completely or not at all. Later writes win, and ops see
 * the effect of earlier ops in the same call.
 */
export function planDraw(cells: Uint32Array, input: DrawInput): DrawPlan {
  const hasRows = input.rows !== undefined && input.rows !== null;
  if (input.ops !== undefined && input.ops !== null && typeof input.ops !== "string") {
    fail(`"ops" must be a string of ";"-separated commands`);
  }
  const hasOps = typeof input.ops === "string" && input.ops.trim().length > 0;
  if (!hasRows && !hasOps) fail(`draw needs "rows" or "ops"`);

  const palette = parsePalette(input.palette);
  if (readFormat(input.format) === "rle") {
    const digitKey = [...palette.keys()].find(isDigit);
    if (digitKey !== undefined) {
      fail(`palette key "${digitKey}" cannot be a digit when format is "rle" — digits are run counts there`);
    }
  }
  const warnings: string[] = [];
  const writes: Write[] = [];

  const { flipX, flipY } = readMirror(input.mirror);

  // Live view of the canvas as the call is planned, so `bucket` sees earlier ops.
  const overlay = new Map<number, number>();
  let scratch: Uint32Array | null = null;

  const emit = (x: number, y: number, value: number) => {
    // Counted before the push, and counting clipped writes too, because the
    // allocation happens either way. A single op can otherwise queue millions
    // of objects before anything checks the limit.
    if (writes.length >= MAX_CALL_CELLS) {
      fail(`this call would plan more than ${MAX_CALL_CELLS} writes; the limit is ${MAX_CALL_CELLS}`);
    }
    writes.push({ x, y, value });
    if (!isOnCanvas(x, y)) return;
    const index = cellIndex(x, y);
    overlay.set(index, value);
    if (scratch) scratch[index] = value;
  };

  /**
   * Mirroring happens here rather than in a pass at the end, so the overlay a
   * later `bucket` reads is already symmetric. Otherwise an agent could draw
   * half a closed shape with `mirror` and have the fill escape through the half
   * that had not been reflected yet.
   */
  const record = (x: number, y: number, value: number) => {
    emit(x, y, value);
    if (flipX) emit(-x - 1, y, value);
    if (flipY) emit(x, -y - 1, value);
    if (flipX && flipY) emit(-x - 1, -y - 1, value);
  };

  const readCell = (x: number, y: number) => {
    const index = cellIndex(x, y);
    const pending = overlay.get(index);
    return pending === undefined ? cells[index] : pending;
  };

  const materializeScratch = () => {
    if (scratch) return scratch;
    scratch = cells.slice();
    for (const [index, value] of overlay) scratch[index] = value;
    return scratch;
  };

  if (hasRows) planRows(input, palette, record, warnings);
  if (hasOps) planOps(input.ops as string, palette, record, readCell, materializeScratch);

  return summarize(cells, writes, warnings, { mirrored: flipX || flipY, usedOps: hasOps });
}

function planRows(
  input: DrawInput,
  palette: Map<string, number>,
  record: (x: number, y: number, value: number) => void,
  warnings: string[],
) {
  if (input.origin === undefined || input.origin === null) {
    fail(`"rows" needs "origin" (the top-left canvas position)`);
  }
  const at = readPoint(input.origin, `"origin"`);
  const rows = input.rows;
  if (!Array.isArray(rows) || rows.some((row) => typeof row !== "string")) {
    fail(`"rows" must be an array of strings`);
  }
  const source = rows as string[];
  const rle = readFormat(input.format) === "rle";

  const maxRows = rle ? MAX_RLE_ROWS : MAX_ROWS;
  if (source.length > maxRows) fail(`rows: ${source.length} rows exceeds the limit of ${maxRows}`);

  const lines = rle ? source.map((row, index) => decodeRleRow(row, `rows: row ${index + 1}`)) : source;

  let widest = 0;
  lines.forEach((row, index) => {
    if (!rle && row.length > MAX_ROW_LENGTH) {
      fail(`rows: row ${index + 1} is ${row.length} characters; the limit is ${MAX_ROW_LENGTH}`);
    }
    if (row.length > widest) widest = row.length;
  });
  const area = widest * lines.length;
  const maxCells = rle ? MAX_RLE_CELLS : MAX_ROWS_CELLS;
  if (area > maxCells) {
    fail(
      rle
        ? `rows: those runs decode to ${area} cells, over the limit of ${maxCells}`
        : `rows: ${area} cells exceeds the limit of ${maxCells}. Send the same picture as format:"rle" to fit up to ${MAX_RLE_CELLS}`,
    );
  }

  const short = lines.map((row, index) => (row.length < widest ? index + 1 : 0)).filter((index) => index > 0);
  if (short.length > 0) {
    const list = short.length === 1 ? `row ${short[0]}` : `rows ${short.slice(0, -1).join(", ")} and ${short.at(-1)}`;
    warnings.push(`${list} ${short.length === 1 ? "is" : "are"} shorter than the widest row`);
  }

  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    for (let column = 0; column < widest; column += 1) {
      const x = at.x + column;
      const y = at.y + row;
      const char = column < line.length ? line[column] : ".";
      if (char === "-") {
        record(x, y, ERASE);
        continue;
      }
      // `.` composites: stamping a motif must not scrub the art around it.
      // Deleting is always explicit, with `-`.
      if (char === ".") continue;
      const value = palette.get(char);
      if (value === undefined) fail(`rows: row ${row + 1} uses "${char}", which is not in the palette`);
      record(x, y, value);
    }
  }
}

export const MAX_OPS_LENGTH = 4000;

function planOps(
  source: string,
  palette: Map<string, number>,
  record: (x: number, y: number, value: number) => void,
  readCell: (x: number, y: number) => number,
  materializeScratch: () => Uint32Array,
) {
  if (source.length > MAX_OPS_LENGTH) {
    fail(`ops: ${source.length} characters exceeds the limit of ${MAX_OPS_LENGTH}`);
  }
  const ops = source
    .split(/[;\n]/)
    .map((op) => op.trim())
    .filter((op) => op.length > 0);
  if (ops.length > MAX_OPS) fail(`ops: ${ops.length} ops exceeds the limit of ${MAX_OPS}`);

  let current: number | null = null;

  ops.forEach((op, index) => {
    const tokens = op.split(/\s+/);
    const name = tokens[0].toLowerCase();
    const args = tokens.slice(1);
    const where = `ops op ${index + 1} "${tokens[0]}"`;

    const integers = (count: number, label: string) => {
      if (args.length !== count) fail(`${where}: needs ${count} integers (${label}), got ${args.length}`);
      return args.map((token) => readOpInt(token, where));
    };

    const color = () => {
      if (current === null) {
        fail(`${where}: no color set yet — start with "c <palette character or #rrggbb>"`);
      }
      return current as number;
    };

    if (name === "c") {
      if (args.length !== 1) fail(`${where}: needs one color, got ${args.length} values`);
      current = readOpColor(args[0], palette, where);
      return;
    }

    if (name === "px") {
      const value = color();
      if (args.length === 0 || args.length % 2 !== 0) {
        fail(`${where}: needs x y pairs, got an odd number of values`);
      }
      const pairs = args.length / 2;
      if (pairs > MAX_PX_PAIRS) fail(`${where}: ${pairs} pairs exceeds the limit of ${MAX_PX_PAIRS}`);
      for (let pair = 0; pair < pairs; pair += 1) {
        record(readOpInt(args[pair * 2], where), readOpInt(args[pair * 2 + 1], where), value);
      }
      return;
    }

    if (name === "line") {
      const value = color();
      const [x0, y0, x1, y1] = integers(4, "x0 y0 x1 y1");
      const span = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1;
      if (span > MAX_SHAPE_PIXELS) {
        fail(`${where}: that shape is ${span} pixels; the limit is ${MAX_SHAPE_PIXELS} per op`);
      }
      for (const point of pixelsOnLine({ x: x0, y: y0 }, { x: x1, y: y1 }, "#000000")) {
        record(point.x, point.y, value);
      }
      return;
    }

    if (name === "poly" || name === "path") {
      const value = color();
      const closed = name === "poly";
      let coordinates = args;
      let filled = false;
      if (closed && coordinates.at(-1)?.toLowerCase() === "f") {
        filled = true;
        coordinates = coordinates.slice(0, -1);
      }
      if (coordinates.length % 2 !== 0) {
        fail(`${where}: needs x y pairs${closed ? " and an optional f" : ""}, got an odd number of values`);
      }
      const least = closed ? 3 : 2;
      if (coordinates.length / 2 < least) {
        fail(`${where}: needs at least ${least} points, got ${coordinates.length / 2}`);
      }
      if (coordinates.length / 2 > MAX_POLY_POINTS) {
        fail(`${where}: ${coordinates.length / 2} points exceeds the limit of ${MAX_POLY_POINTS}`);
      }
      const points: Point[] = [];
      for (let pair = 0; pair < coordinates.length / 2; pair += 1) {
        points.push({
          x: readOpInt(coordinates[pair * 2], where),
          y: readOpInt(coordinates[pair * 2 + 1], where),
        });
      }

      // Priced before anything is generated: the outline by the span of its
      // segments, a fill by the box that bounds it.
      let cost = 0;
      const edges = closed ? points.length : points.length - 1;
      for (let edge = 0; edge < edges; edge += 1) {
        const from = points[edge];
        const to = points[(edge + 1) % points.length];
        cost += Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) + 1;
      }
      if (filled) {
        const xs = points.map((point) => point.x);
        const ys = points.map((point) => point.y);
        cost += (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
      }
      if (cost > MAX_SHAPE_PIXELS) {
        fail(`${where}: that shape is about ${cost} pixels; the limit is ${MAX_SHAPE_PIXELS} per op`);
      }

      if (filled) {
        for (const point of pixelsInPolygon(points)) record(point.x, point.y, value);
      }
      // Always stroked, so a filled shape keeps a crisp edge and a spur too thin
      // for the scanline still appears.
      for (let edge = 0; edge < edges; edge += 1) {
        const from = points[edge];
        const to = points[(edge + 1) % points.length];
        for (const point of pixelsOnLine(from, to, "#000000")) record(point.x, point.y, value);
      }
      return;
    }

    if (name === "fill") {
      if (args.length < 7 || args.length > 8) {
        fail(`${where}: needs x0 y0 x1 y1, a mode, two colors and an optional number, got ${args.length} values`);
      }
      const [x0, y0, x1, y1] = args.slice(0, 4).map((token) => readOpInt(token, where));
      const mode = args[4].toLowerCase();
      if (mode !== "checker" && mode !== "dither") {
        fail(`${where}: "${args[4]}" is not a fill mode (use checker or dither)`);
      }
      const first = readOpColor(args[5], palette, where);
      const second = readOpColor(args[6], palette, where);
      const region = intersectCanvas({
        minX: Math.min(x0, x1),
        minY: Math.min(y0, y1),
        maxX: Math.max(x0, x1),
        maxY: Math.max(y0, y1),
      });
      // Entirely off canvas is nothing to do, matching how other writes clip.
      if (!region) return;
      const area = (region.maxX - region.minX + 1) * (region.maxY - region.minY + 1);
      if (area > MAX_SHAPE_PIXELS) {
        fail(`${where}: that region is ${area} pixels; the limit is ${MAX_SHAPE_PIXELS} per op`);
      }

      const given = args.length === 8 ? readOpInt(args[7], where) : null;
      if (mode === "checker") {
        const size = given ?? 1;
        if (size < 1 || size > MAX_CHECKER_SIZE) {
          fail(`${where}: checker square size must be 1 to ${MAX_CHECKER_SIZE}, got ${size}`);
        }
        for (let y = region.minY; y <= region.maxY; y += 1) {
          for (let x = region.minX; x <= region.maxX; x += 1) {
            record(x, y, checkerPicksFirst(x, y, size) ? first : second);
          }
        }
        return;
      }

      const percent = given ?? 50;
      if (percent < 0 || percent > 100) {
        fail(`${where}: dither percent must be 0 to 100, got ${percent}`);
      }
      for (let y = region.minY; y <= region.maxY; y += 1) {
        for (let x = region.minX; x <= region.maxX; x += 1) {
          record(x, y, ditherPicksSecond(x, y, percent) ? second : first);
        }
      }
      return;
    }

    if (name === "rect" || name === "ellipse") {
      const value = color();
      const filled = args.length === 5;
      if (args.length !== 4 && args.length !== 5) {
        fail(`${where}: needs 4 integers (x0 y0 x1 y1) and an optional f, got ${args.length} values`);
      }
      if (filled && args[4].toLowerCase() !== "f") {
        fail(`${where}: "${args[4]}" is not a flag (use f for filled)`);
      }
      const [x0, y0, x1, y1] = args.slice(0, 4).map((token) => readOpInt(token, where));
      const shape = pixelsInShape(
        name === "rect" ? "rectangle" : "ellipse",
        { x: x0, y: y0 },
        { x: x1, y: y1 },
        filled ? "filled" : "outline",
        "#000000",
        { horizontal: false, vertical: false },
      );
      if (!shape) {
        const width = Math.abs(x1 - x0) + 1;
        const height = Math.abs(y1 - y0) + 1;
        fail(`${where}: that shape is ${width * height} pixels; the limit is ${MAX_SHAPE_PIXELS} per op`);
      }
      for (const point of shape) record(point.x, point.y, value);
      return;
    }

    if (name === "recolor") {
      if (args.length !== 6) {
        fail(`${where}: needs 6 values (from to x0 y0 x1 y1), got ${args.length}`);
      }
      const from = readOpColor(args[0], palette, where);
      const to = readOpColor(args[1], palette, where);
      if (from === ERASE) {
        fail(`${where}: "from" cannot be "-" — use rect or bucket to paint empty space`);
      }
      if (from === to) return;
      const [x0, y0, x1, y1] = args.slice(2).map((token) => readOpInt(token, where));
      const area = intersectCanvas({
        minX: Math.min(x0, x1),
        minY: Math.min(y0, y1),
        maxX: Math.max(x0, x1),
        maxY: Math.max(y0, y1),
      });
      // Entirely off canvas is nothing to do, matching how other writes clip.
      if (!area) return;
      for (let y = area.minY; y <= area.maxY; y += 1) {
        for (let x = area.minX; x <= area.maxX; x += 1) {
          if (readCell(x, y) === from) record(x, y, to);
        }
      }
      return;
    }

    if (name === "bucket") {
      const value = color();
      const [x, y] = integers(2, "x y");
      if (!isOnCanvas(x, y)) {
        fail(`${where}: (${x}, ${y}) is off the ${CANVAS_MIN}..${CANVAS_MAX} canvas`);
      }
      const target = readCell(x, y);
      if (target === value) return;
      // floodFill bails out when the replacement equals the target, so hand it a
      // color that cannot match. Only the coordinates it returns are used.
      const probe =
        value === ERASE ? (target === cellFromColor("#000000") ? "#ffffff" : "#000000") : colorFromCell(value);
      const filled = floodFill(materializeScratch(), { x, y }, probe);
      for (const point of filled.changes) record(point.x, point.y, value);
      return;
    }

    fail(`${where}: unknown op (use c, px, line, poly, path, rect, ellipse, fill, bucket, recolor)`);
  });
}

function readOpInt(token: string, where: string) {
  if (!WHOLE_NUMBER.test(token)) fail(`${where}: "${token}" is not a whole number`);
  const value = Number(token);
  if (value < -OP_COORDINATE_LIMIT || value >= OP_COORDINATE_LIMIT) {
    fail(`${where}: coordinate ${value} is out of range (${-OP_COORDINATE_LIMIT}..${OP_COORDINATE_LIMIT - 1})`);
  }
  return value;
}

function readOpColor(token: string, palette: Map<string, number>, where: string) {
  if (token === "-") return ERASE;
  if (HEX_COLOR.test(token)) return cellFromColor(normalizeHex(token));
  const known = palette.get(token);
  if (known !== undefined) return known;
  fail(`${where}: unknown color "${token}" — not in the palette and not #rgb/#rrggbb`);
  return ERASE;
}

function summarize(
  cells: Uint32Array,
  writes: Write[],
  warnings: string[],
  already: { mirrored: boolean; usedOps: boolean },
): DrawPlan {
  const final = new Map<number, number>();
  let clipped = 0;
  for (const { x, y, value } of writes) {
    if (!isOnCanvas(x, y)) {
      clipped += 1;
      continue;
    }
    final.set(cellIndex(x, y), value);
  }

  const changes: PixelChange[] = [];
  let painted = 0;
  let erased = 0;
  let unchanged = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [index, value] of final) {
    if (cells[index] === value) {
      unchanged += 1;
      continue;
    }
    const x = cellX(index);
    const y = cellY(index);
    if (value === ERASE) erased += 1;
    else painted += 1;
    changes.push({ x, y, color: value === ERASE ? "transparent" : colorFromCell(value) });
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const bounds = changes.length > 0 ? { minX, minY, maxX, maxY } : null;
  const plan: DrawPlan = { changes, painted, erased, unchanged, clipped, bounds, warnings };
  const hint = suggestCheaperCall(final, already);
  if (hint) plan.hint = hint;
  return plan;
}

// ---------------------------------------------------------------------------
// Advisory hints — never enforced, at most one per call
// ---------------------------------------------------------------------------

/**
 * Looks for a substantially cheaper way the same call could have been written.
 * Purely informational: the call has already succeeded exactly as asked.
 */
export function suggestCheaperCall(
  final: Map<number, number>,
  already: { mirrored: boolean; usedOps: boolean },
): string | undefined {
  if (final.size < HINT_MIN_CELLS) return undefined;

  const mirror = already.mirrored ? null : detectMirror(final);
  if (mirror) {
    return `those rows were ${mirror} symmetric — half of them with mirror:"${mirror}" would have been about half the size.`;
  }

  // Only worth saying to a caller who did not already reach for an op.
  const block = already.usedOps ? null : detectSolidBlock(final);
  if (block) {
    const { bounds, color } = block;
    return `the solid block at (${bounds.minX}, ${bounds.minY}) to (${bounds.maxX}, ${bounds.maxY}) is one op: c ${color};rect ${bounds.minX} ${bounds.minY} ${bounds.maxX} ${bounds.maxY} f`;
  }

  return undefined;
}

function detectMirror(final: Map<number, number>): "left-right" | "top-bottom" | null {
  const matches = (mirrorIndex: (x: number, y: number) => number) => {
    for (const [index, value] of final) {
      const partner = final.get(mirrorIndex(cellX(index), cellY(index)));
      if (partner !== value) return false;
    }
    return true;
  };
  const onCanvas = (x: number, y: number) => isOnCanvas(x, y);
  if ([...final.keys()].every((index) => onCanvas(-cellX(index) - 1, cellY(index)))) {
    if (matches((x, y) => cellIndex(-x - 1, y))) return "left-right";
  }
  if ([...final.keys()].every((index) => onCanvas(cellX(index), -cellY(index) - 1))) {
    if (matches((x, y) => cellIndex(x, -y - 1))) return "top-bottom";
  }
  return null;
}

function detectSolidBlock(final: Map<number, number>) {
  const byColor = new Map<number, number[]>();
  for (const [index, value] of final) {
    if (value === ERASE) continue;
    const bucket = byColor.get(value);
    if (bucket) bucket.push(index);
    else byColor.set(value, [index]);
  }
  for (const [value, indices] of byColor) {
    if (indices.length < HINT_MIN_CELLS) continue;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const index of indices) {
      const x = cellX(index);
      const y = cellY(index);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const area = (maxX - minX + 1) * (maxY - minY + 1);
    if (area !== indices.length) continue;
    return { bounds: { minX, minY, maxX, maxY }, color: colorFromCell(value) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading the canvas back
// ---------------------------------------------------------------------------

export type ReadResult = {
  origin: [number, number];
  size: [number, number];
  scale: number;
  /** How `rows` are encoded — plain characters, or runs of "count then character". */
  format: RowFormat;
  /** True only when the rows are pixel-for-pixel and colour-for-colour faithful. */
  exact: boolean;
  folded: number;
  palette: Record<string, string>;
  rows: string[];
  painted: number;
  empty: number;
  colors: Record<string, number>;
  distinctColors: number;
  note?: string;
};

export function scaleForRegion(width: number, height: number, budget = READ_BUDGET) {
  let scale = 1;
  while (Math.ceil(width / scale) > budget || Math.ceil(height / scale) > budget) scale += 1;
  return scale;
}

/** Exact per-color counts over the whole region, independent of any downscaling. */
function tallyRegion(cells: Uint32Array, area: SelectionBounds) {
  const histogram = new Map<number, number>();
  let painted = 0;
  for (let y = area.minY; y <= area.maxY; y += 1) {
    for (let x = area.minX; x <= area.maxX; x += 1) {
      const cell = cells[cellIndex(x, y)];
      if (cell === EMPTY_CELL) continue;
      painted += 1;
      histogram.set(cell, (histogram.get(cell) ?? 0) + 1);
    }
  }
  return { painted, histogram };
}

/** Reduces a region to one cell per scale x scale block, picking each block's most common color. */
function sampleRegion(cells: Uint32Array, area: SelectionBounds, scale: number) {
  const width = area.maxX - area.minX + 1;
  const height = area.maxY - area.minY + 1;
  const columns = Math.ceil(width / scale);
  const lines = Math.ceil(height / scale);
  const winners = new Uint32Array(columns * lines);
  const counts = new Map<number, number>();
  const block = new Map<number, number>();

  for (let row = 0; row < lines; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      block.clear();
      let best = EMPTY_CELL;
      let bestCount = 0;
      const lastY = Math.min(height, (row + 1) * scale);
      const lastX = Math.min(width, (column + 1) * scale);
      for (let y = row * scale; y < lastY; y += 1) {
        for (let x = column * scale; x < lastX; x += 1) {
          const cell = cells[cellIndex(area.minX + x, area.minY + y)];
          if (cell === EMPTY_CELL) continue;
          const count = (block.get(cell) ?? 0) + 1;
          block.set(cell, count);
          // Most common wins; a tie goes to the lower packed value so the same
          // canvas always reads back identically.
          if (count > bestCount || (count === bestCount && cell < best)) {
            best = cell;
            bestCount = count;
          }
        }
      }
      winners[row * columns + column] = best;
      if (best !== EMPTY_CELL) counts.set(best, (counts.get(best) ?? 0) + 1);
    }
  }
  return { winners, columns, lines, counts };
}

/** Turns sampled cells into palette characters, folding anything past the alphabet. */
function describeSample(sample: ReturnType<typeof sampleRegion>) {
  const { winners, columns, lines, counts } = sample;
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([cell]) => cell);
  const kept = ordered.slice(0, READ_ALPHABET.length);
  const chars = new Map<number, string>();
  kept.forEach((cell, index) => {
    chars.set(cell, READ_ALPHABET[index]);
  });

  const folded = ordered.length - kept.length;
  for (const cell of ordered.slice(kept.length)) chars.set(cell, READ_ALPHABET[nearestKept(cell, kept)]);

  const rows: string[] = [];
  for (let row = 0; row < lines; row += 1) {
    let line = "";
    for (let column = 0; column < columns; column += 1) {
      const cell = winners[row * columns + column];
      line += cell === EMPTY_CELL ? "." : (chars.get(cell) ?? ".");
    }
    rows.push(line);
  }

  const palette: Record<string, string> = {};
  kept.forEach((cell, index) => {
    palette[READ_ALPHABET[index]] = colorFromCell(cell);
  });

  return { rows, palette, folded };
}

export function readRegion(cells: Uint32Array, region: SelectionBounds | null): ReadResult {
  const budget = region ? READ_BUDGET : READ_OVERVIEW_BUDGET;
  const art = region ?? paintedBounds(cells);
  if (!art) {
    return {
      origin: [0, 0],
      size: [0, 0],
      scale: 1,
      format: "chars",
      exact: true,
      folded: 0,
      palette: {},
      rows: [],
      painted: 0,
      empty: 0,
      colors: {},
      distinctColors: 0,
    };
  }
  const area = intersectCanvas(art);
  if (!area) fail(`region is entirely off the ${CANVAS_MIN}..${CANVAS_MAX} canvas`);
  const width = area.maxX - area.minX + 1;
  const height = area.maxY - area.minY + 1;

  const { painted, histogram } = tallyRegion(cells, area);

  const plainScale = scaleForRegion(width, height, budget);
  let scale = plainScale;
  let format: RowFormat = "chars";
  let described = describeSample(sampleRegion(cells, area, plainScale));

  if (plainScale > 1 && width * height <= MAX_RLE_CELLS) {
    const exactly = describeSample(sampleRegion(cells, area, 1));
    const encoded = exactly.rows.map(encodeRleRow);
    const cost = encoded.reduce((total, row) => total + row.length + 3, 0);
    if (cost <= READ_RLE_BUDGET && exactly.folded === 0) {
      scale = 1;
      format = "rle";
      described = { ...exactly, rows: encoded };
    }
  }

  const ranked = [...histogram.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const colors: Record<string, number> = {};
  for (const [cell, count] of ranked.slice(0, READ_HISTOGRAM)) colors[colorFromCell(cell)] = count;

  const notes: string[] = [];
  if (format === "rle") {
    notes.push(
      `format "rle": each row is runs of "count then character", so 12k is twelve k. These rows are exact — decode them, edit, and draw back with format:"rle".`,
    );
  }
  if (scale > 1) {
    notes.push(
      `scale ${scale}: each character covers a ${scale}x${scale} block, so these rows are an overview, not exact pixels.`,
    );
  }
  if (described.folded > 0) {
    notes.push(`${described.folded} rare colors were folded into the nearest kept color.`);
  }
  if (ranked.length > READ_HISTOGRAM) {
    notes.push(
      `"colors" lists the ${READ_HISTOGRAM} most used of ${ranked.length} colors; the counts it gives are exact.`,
    );
  }

  const result: ReadResult = {
    origin: [area.minX, area.minY],
    size: [width, height],
    scale,
    format,
    // Geometry alone is not enough: a 32x32 region with 80 colours is scale 1
    // and still lossy, so folding has to count against exactness too.
    exact: scale === 1 && described.folded === 0,
    folded: described.folded,
    palette: described.palette,
    rows: described.rows,
    painted,
    empty: width * height - painted,
    colors,
    distinctColors: ranked.length,
  };
  if (notes.length > 0) result.note = notes.join(" ");
  return result;
}

function nearestKept(cell: number, kept: number[]) {
  const red = (cell >>> 16) & 255;
  const green = (cell >>> 8) & 255;
  const blue = cell & 255;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  kept.forEach((candidate, index) => {
    const dr = ((candidate >>> 16) & 255) - red;
    const dg = ((candidate >>> 8) & 255) - green;
    const db = (candidate & 255) - blue;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}
