# MCPixels

A small unbounded pixel editor that a person and an AI agent can edit on the same live page. Use Draw, Erase, and Fill to edit pixels; drag to stamp lines, outlined or filled rectangles, and outlined or filled ellipses; pick existing colors with the palette eyedropper; or Select to clear, copy, cut, paste, export, move, flip, and rotate rectangular selections. Drag inside an active selection to move it; flip and rotate transform the selected pixels in place. Horizontal and vertical mirror modes reflect brush strokes, erasing, and shapes across the highlighted origin axes, and can be enabled together for four-way symmetry. Switch tools with B (Draw), E (Erase), G (Fill), L (Line), R (Rectangle), O (Ellipse), I (eyedropper), H (Pan), and M (Select). Non-default colors persist and move to the front of the fixed-size palette when reused. Fill replaces contiguous color regions and enclosed transparent regions. PNG exports support a scale multiplier or exact output dimensions. Import brings an image in the other way — click Import, drop a file on the canvas, or paste one from the clipboard; upscaled pixel art has its pixel grid detected so each art pixel becomes one canvas pixel instead of a block of them, which works even when the art was rescaled by a fractional factor that blended the cell edges or left part of a cell at the border (a 347 by 379px sprite comes in as its real 32 by 35, a 590 by 576px one as 98 by 96); one cell size is fitted across both axes, so an import never comes in stretched, and art that holds no readable grid comes in at full size rather than squashed; transparent pixels stay empty, and the result drops into an active selection or at the center of the view as a single undoable step. Undo and Redo are available as buttons and with standard keyboard shortcuts. Right-drag, middle-drag, Space-drag, or use Pan to move. Pan also supports two-finger pinch zoom on touch screens.

## Run locally

```bash
npm install
npm run dev
```

The app works as a normal pixel editor in every modern browser. In a WebMCP-compatible browser it also registers five site tools:

- `get_sprite`
- `paint_pixels`
- `erase_pixels`
- `set_canvas_view`
- `clear_sprite`

For ChatGPT, open the app in the ChatGPT desktop app's built-in browser and inspect **Site tools** in the address bar. For Chrome testing, enable `chrome://flags/#enable-webmcp-testing` in a compatible Chrome build.

## Deploy

The production site is a static Cloudflare Pages deployment. No Pages Functions or usage-billed backend services are enabled.

```bash
npm run deploy
```

The command typechecks and builds the app before deploying `dist` to the `mcpixels` Pages project from the `main` branch.
