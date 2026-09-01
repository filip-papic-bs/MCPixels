# MCPixels

A 1024×1024 pixel-art canvas that a person and an AI agent edit together, live, on the
same page. Live at <https://mcpixels.app/>.

This is the markdown representation of the homepage. The page itself is a pixel editor:
draw, shapes, fill, selections, mirroring, import, PNG export, undo — ordinary in any
browser. In a WebMCP browser it also hands an agent **six site tools** covering
everything but image import. There is no backend; the tools are registered by the page
itself via `document.modelContext.registerTool`.

Built for [OpenAI's WebMCP Challenge](https://webmcp.devpost.com/).

## The canvas

Coordinates are centred: `x` and `y` run **-512..511**, `y` downward, so `(0, 0)` is the
middle. The canvas lives in the browser tab — nothing is stored on a server and nothing
is shared between visitors.

## The six tools

| # | tool | what it does |
| --- | --- | --- |
| 1 | `draw_pixel_art` | The only tool you send pixel data to. Takes a picture (`rows` of palette characters), a command string (`ops` — line, rect, ellipse, flood fill, recolour, pixels), or both, plus optional `mirror`. One call is one undo step, unless it changed nothing. |
| 2 | `read_canvas` | Reads any region back in exactly the format `draw_pixel_art` accepts, with an `exact` flag saying whether the rows are faithful. A read costs at most ~2,600 tokens whatever is on the canvas. |
| 3 | `selection` | Rearranges art already on the canvas: `duplicate` (with `times`), `move`, `erase`, `flip-left-right`, `flip-top-bottom`, `rotate`, `copy`/`cut`/`paste`, `set`/`dismiss`. No pixel data travels through it. |
| 4 | `edit` | `undo`, `redo` (up to 20 steps at once), or `clear-canvas`. The agent and the person share one edit timeline. |
| 5 | `view` | Frames a region on screen. Draws nothing — edits bring themselves into view on their own. |
| 6 | `export_pixel_art` | Saves a region as a PNG to the person's downloads at a chosen scale. |

The whole surface costs about **1,260 tokens** of context, because every tool's
description and schema sits in the model's context on every turn.

## Pictures, not coordinates

Sending a 32×32 sprite as `[{x, y, color}, …]` costs about 22,500 tokens. As rows of
palette characters it costs about 400 — and the agent can see what it is writing:

```js
draw_pixel_art({
  origin: [-4, -3],
  palette: { k: "#161616", r: "#ff5c35", w: "#f5f1e8" },
  rows: ["..kkkk..", ".krrrrk.", "kr.ww.rk", "krrrrrrk", ".kkkkkk."],
})
```

`.` leaves a cell alone, `-` erases it — stamping never scrubs the art underneath.
Larger geometry goes through `ops` instead — `c #2d7ff9;rect -20 -20 20 20 f;bucket 0 0`
— and both can be combined in one call. Because `read_canvas` returns the same shape,
read → edit the rows → draw back is a closed loop with no reformatting.

## Trying it as an agent

- **ChatGPT** — open the site in the ChatGPT desktop app's built-in browser, then check
  **Site tools** in the address bar.
- **Chrome 149+** — enable `chrome://flags/#enable-webmcp-testing`, then from the
  console: `navigator.modelContext.getTools()` and
  `executeTool("draw_pixel_art", { … })`.

## Watching the agent work

Agent actions appear in a notice feed under the header; the person's own edits stay out
of it. When an agent draws off screen the view eases across to frame it and the area
flashes, so its work is not invisible — switched off with **Follow agent edits** in the
dock's ••• menu.

## More

- Full skill for agents: </.well-known/agent-skills/drawing-on-mcpixels/SKILL.md>
- Short agent guide: </llms.txt>
- Authentication (there is none): </auth.md>
- Source, AGPL-3.0-or-later: <https://github.com/filip-papic-bs/MCPixels>
