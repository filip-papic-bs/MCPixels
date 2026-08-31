import { EMPTY_PIXEL, MAX_CUSTOM_COLORS, PALETTE } from "../pixels.ts";
import { useEditorRuntime, useEditorState } from "./EditorProvider.tsx";

export function usePalette() {
  const { selectedColor, customColors, pendingColor } = useEditorState();
  const { setSelectedColor, setPendingColor, setCustomColors } = useEditorRuntime();

  const selectEditorColor = (value: string) => {
    const color = value.toLowerCase();
    setSelectedColor(color);
    if (PALETTE.includes(color)) return;
    setPendingColor(customColors.includes(color) ? null : color);
  };

  const keepUsedColor = (color: string) => {
    if (color === EMPTY_PIXEL || PALETTE.includes(color)) return;
    setPendingColor((current) => (current === color ? null : current));
    setCustomColors((current) =>
      current[0] === color
        ? current
        : [color, ...current.filter((entry) => entry !== color)].slice(0, MAX_CUSTOM_COLORS),
    );
  };

  const paletteColors = [
    ...(pendingColor && !customColors.includes(pendingColor) ? [pendingColor] : []),
    ...customColors,
    ...PALETTE,
  ].slice(0, PALETTE.length);

  return { selectedColor, paletteColors, selectEditorColor, keepUsedColor };
}
