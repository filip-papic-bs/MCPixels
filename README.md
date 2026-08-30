# MCPixels

A small unbounded pixel editor that a person and an AI agent can edit on the same live page. Draw with Pencil, erase with Eraser, or use Lasso to clear and copy rectangular selections. Copied pixels can be pasted at the top-left of a new selection. Right-drag, middle-drag, Space-drag, or use Hand to pan. Hand also supports two-finger pinch zoom on touch screens.

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
