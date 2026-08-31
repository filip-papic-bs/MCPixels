import { MAX_EXPORT_DIMENSION, clampSelectionToCanvas } from "../pixels.ts";
import type { SelectionBounds } from "../pixels.ts";
import { packCells } from "./pack.ts";

export function renderRegionCanvas(cells: Uint32Array, bounds: SelectionBounds) {
  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const image = context.createImageData(width, height);
  packCells(cells, clampSelectionToCanvas(bounds), bounds.minX, bounds.minY, width, image.data);
  context.putImageData(image, 0, 0);
  return canvas;
}

export function canvasToPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("Could not encode the PNG"));
    }, "image/png");
  });
}

export async function renderScaledPng(
  cells: Uint32Array,
  bounds: SelectionBounds,
  output: { width: number; height: number },
) {
  const source = renderRegionCanvas(cells, bounds);
  if (!source) throw new Error("Could not create the export canvas");

  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create the scaled export canvas");
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0, output.width, output.height);
  return canvasToPng(canvas);
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function fitExportScale(bounds: SelectionBounds, scale: number) {
  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  if (width > MAX_EXPORT_DIMENSION || height > MAX_EXPORT_DIMENSION) {
    throw new Error(`region is larger than ${MAX_EXPORT_DIMENSION} pixels per side`);
  }
  const limited = Math.max(
    1,
    Math.min(scale, Math.floor(MAX_EXPORT_DIMENSION / width), Math.floor(MAX_EXPORT_DIMENSION / height)),
  );
  return { scale: limited, width: width * limited, height: height * limited };
}
