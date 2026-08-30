# MCPixels

A small unbounded pixel editor that a person and an AI agent can edit on the same live page. Use Draw and Erase to edit pixels, or Select to clear, copy, cut, paste, and export rectangular selections. PNG exports support a scale multiplier or exact output dimensions. Right-drag, middle-drag, Space-drag, or use Pan to move. Pan also supports two-finger pinch zoom on touch screens.

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
