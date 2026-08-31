import { useEffect } from "react";
import {
  MAX_IMPORT_DIMENSION,
  carriesFiles,
  findImageFile,
  fitImportDimensions,
  importOriginFor,
  placeRegion,
  rasterizeImportSource,
  readImageSize,
  readImportSource,
} from "../pixels.ts";
import { useEditorRuntime, useEditorState } from "./EditorProvider.tsx";

export function useImportPanel() {
  const { importSource, importDimensions, lockImportRatio, selection, viewport } = useEditorState();
  const runtime = useEditorRuntime();
  const {
    actions,
    dispatch,
    clipboardPngRef,
    latest,
    setActivity,
    setImportDimensions,
    setImportError,
    setImportSource,
    setIsReadingImport,
    setLockImportRatio,
    setSelection,
    setShowExport,
    setShowImport,
  } = runtime;

  const importDetectedSize = importSource ? { width: importSource.columns, height: importSource.rows } : null;
  const importFoundGrid = Boolean(
    importSource && (importSource.columns < importSource.width || importSource.rows < importSource.height),
  );
  const importFittedSize = importDetectedSize
    ? fitImportDimensions(importDetectedSize.width, importDetectedSize.height)
    : null;
  const importSizeError =
    importSource && (importDimensions.width > MAX_IMPORT_DIMENSION || importDimensions.height > MAX_IMPORT_DIMENSION)
      ? `Imports must be at most ${MAX_IMPORT_DIMENSION} pixels per side.`
      : "";
  const importOrigin = importOriginFor(selection, viewport, importDimensions.width, importDimensions.height);

  const readImportFile = async (file: File | null) => {
    if (!file) return;
    setShowExport(false);
    setShowImport(true);
    setImportSource(null);
    setImportError("");
    setIsReadingImport(true);
    try {
      const source = await readImportSource(file);
      setImportSource(source);
      setImportDimensions(fitImportDimensions(source.columns, source.rows));
      setLockImportRatio(true);
      setActivity(
        source.columns < source.width || source.rows < source.height
          ? `Read ${source.name}: ${source.width} by ${source.height} pixels holding a ${source.columns} by ${source.rows} pixel grid.`
          : `Read ${source.name}: ${source.width} by ${source.height} pixels, no pixel grid detected.`,
      );
    } catch (error) {
      console.error("Could not read the image to import", error);
      setImportError(error instanceof Error ? error.message : "Could not read that image");
    } finally {
      setIsReadingImport(false);
    }
  };

  useEffect(() => {
    const routePastedImage = async (file: File) => {
      const own = clipboardPngRef.current;
      const state = latest.current;
      if (own && state.copiedSelection && !state.showExport && !state.showImport) {
        const size = await readImageSize(file);
        if (size && size.width === own.width && size.height === own.height) {
          actions.current.pasteSelection();
          return;
        }
      }
      await readImportFile(file);
    };

    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select") || target?.isContentEditable) return;
      const file = findImageFile(event.clipboardData?.files, event.clipboardData?.items);
      if (file) {
        event.preventDefault();
        void routePastedImage(file);
        return;
      }
      const state = latest.current;
      if (state.showExport || state.showImport || !state.copiedSelection) return;
      event.preventDefault();
      actions.current.pasteSelection();
    };
    const blockFileDrop = (event: DragEvent) => {
      if (carriesFiles(event.dataTransfer)) event.preventDefault();
    };
    window.addEventListener("paste", handlePaste);
    window.addEventListener("dragover", blockFileDrop);
    window.addEventListener("drop", blockFileDrop);
    return () => {
      window.removeEventListener("paste", handlePaste);
      window.removeEventListener("dragover", blockFileDrop);
      window.removeEventListener("drop", blockFileDrop);
    };
  }, [actions, clipboardPngRef, latest]);

  const updateImportWidth = (value: number) => {
    if (!importDetectedSize) return;
    let width = Math.min(MAX_IMPORT_DIMENSION, Math.max(1, Math.round(value) || 1));
    let height = lockImportRatio
      ? Math.max(1, Math.round(width * (importDetectedSize.height / importDetectedSize.width)))
      : importDimensions.height;
    if (height > MAX_IMPORT_DIMENSION) {
      height = MAX_IMPORT_DIMENSION;
      width = Math.max(1, Math.round(height * (importDetectedSize.width / importDetectedSize.height)));
    }
    setImportDimensions({ width, height });
    setImportError("");
  };

  const updateImportHeight = (value: number) => {
    if (!importDetectedSize) return;
    let height = Math.min(MAX_IMPORT_DIMENSION, Math.max(1, Math.round(value) || 1));
    let width = lockImportRatio
      ? Math.max(1, Math.round(height * (importDetectedSize.width / importDetectedSize.height)))
      : importDimensions.width;
    if (width > MAX_IMPORT_DIMENSION) {
      width = MAX_IMPORT_DIMENSION;
      height = Math.max(1, Math.round(width * (importDetectedSize.height / importDetectedSize.width)));
    }
    setImportDimensions({ width, height });
    setImportError("");
  };

  const updateImportRatioLock = (locked: boolean) => {
    setLockImportRatio(locked);
    if (!locked || !importDetectedSize) return;
    let width = importDimensions.width;
    let height = Math.max(1, Math.round(width * (importDetectedSize.height / importDetectedSize.width)));
    if (height > MAX_IMPORT_DIMENSION) {
      height = MAX_IMPORT_DIMENSION;
      width = Math.max(1, Math.round(height * (importDetectedSize.width / importDetectedSize.height)));
    }
    setImportDimensions({ width, height });
  };

  const closeImportPanel = () => {
    setShowImport(false);
    setImportSource(null);
    setImportError("");
    setActivity("Import cancelled.");
  };

  const placeImportedImage = () => {
    if (!importSource || importSizeError) return;
    const { width, height } = importDimensions;
    const origin = importOriginFor(selection, viewport, width, height);
    const changes = placeRegion(
      { pixels: rasterizeImportSource(importSource, width, height), width, height, origin },
      origin,
    );
    if (changes.length === 0) {
      setImportError("Every pixel in that image is transparent.");
      return;
    }
    dispatch({ type: "paint", changes });
    setSelection({ minX: origin.x, minY: origin.y, maxX: origin.x + width - 1, maxY: origin.y + height - 1 });
    setShowImport(false);
    setImportSource(null);
    setActivity(
      `Imported ${changes.length} pixel${changes.length === 1 ? "" : "s"} as a ${width} by ${height} image at (${origin.x}, ${origin.y}).`,
    );
  };

  return {
    importDetectedSize,
    importFoundGrid,
    importFittedSize,
    importSizeError,
    importOrigin,
    readImportFile,
    updateImportWidth,
    updateImportHeight,
    updateImportRatioLock,
    closeImportPanel,
    placeImportedImage,
  };
}
