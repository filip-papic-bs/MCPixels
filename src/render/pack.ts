import { CANVAS_MIN, CANVAS_SIZE, EMPTY_CELL } from "../pixels.ts";
import type { SelectionBounds } from "../pixels.ts";

export function packCells(
  cells: Uint32Array,
  area: SelectionBounds,
  destOriginX: number,
  destOriginY: number,
  destWidth: number,
  data: Uint8ClampedArray,
  skip?: SelectionBounds | null,
) {
  for (let y = area.minY; y <= area.maxY; y += 1) {
    const rowStart = (y - CANVAS_MIN) * CANVAS_SIZE - CANVAS_MIN;
    const target = (y - destOriginY) * destWidth - destOriginX;
    const skipRow = skip != null && y >= skip.minY && y <= skip.maxY;
    for (let x = area.minX; x <= area.maxX; x += 1) {
      const cell = cells[rowStart + x];
      if (cell === EMPTY_CELL) continue;
      if (skipRow && skip && x >= skip.minX && x <= skip.maxX) continue;
      const offset = (target + x) * 4;
      data[offset] = (cell >>> 16) & 255;
      data[offset + 1] = (cell >>> 8) & 255;
      data[offset + 2] = cell & 255;
      data[offset + 3] = 255;
    }
  }
}
