---
name: drawing-on-mcpixels
description: Draw, read back and rearrange pixel art on mcpixels.app through its six in-page WebMCP tools, using the rows-and-palette wire format instead of per-pixel coordinates.
license: AGPL-3.0-or-later
---

# Drawing on MCPixels

[mcpixels.app](https://mcpixels.app/) is a 1024×1024 pixel canvas that a person and
an agent edit at the same time, in the same browser tab. The tools are **WebMCP site
tools**: the page registers them itself with `document.modelContext.registerTool` when
it loads. There is no MCP endpoint to connect to and no account to make — open the page
in a WebMCP-capable browser and six tools appear.

Coordinates are centred: `x` and `y` both run **-512..511**, with `y` increasing
downward. `(0, 0)` is the middle of the canvas.

Because the canvas is an even number of cells across, there is no single centre cell: an
even-sized region centred on the origin runs `-n/2 .. n/2-1`, so a 200×200 area centred on
`(0, 0)` is `[-100, -100, 99, 99]`.

## The six tools

| tool | what it does |
| --- | --- |
| `draw_pixel_art` | The only tool you send pixel data to: `rows` of palette characters (plain or run-length, see `format`), an `ops` command string, or both, plus optional `mirror`. |
| `read_canvas` | Reads a region back in either format `draw_pixel_art` accepts, and reports the canvas state: exact cell and colour counts, bounds, selection, view, history depth and every tool limit. |
| `selection` | Moves art that is already there — duplicate, move, erase, flip, rotate, copy/cut/paste, set/dismiss the marquee. No pixel data travels through it. |
| `edit` | `undo`, `redo` (up to 20 steps), `clear-canvas`. One timeline, shared with the person. |
| `view` | Frames a region on screen. Draws nothing. |
| `export_pixel_art` | Saves a region as a PNG to the person's downloads. |

## Send pictures, not coordinates

A 32×32 sprite as `[{x, y, color}, …]` costs roughly 22,500 tokens. The same sprite as
rows of palette characters costs about 400 — and you can see what you are writing:

```js
draw_pixel_art({
  origin: [-4, -3],
  palette: { k: "#161616", r: "#ff5c35", w: "#f5f1e8" },
  rows: ["..kkkk..", ".krrrrk.", "kr.ww.rk", "krrrrrrk", ".kkkkkk."],
})
```

- `origin` is where the **top-left cell** of `rows` lands.
- `palette` maps one character to one hex colour, up to 64 entries.
- `.` leaves the cell underneath alone; `-` erases it. Stamping never scrubs the art
  around your shape, so build up in layers rather than padding a sprite with background.
- Anything off-canvas is clipped, not an error.

Short rows are padded to the widest row with `.`, so an accidentally short row costs you
nothing but earns a warning — and a *long* row raises the area for every row.

## Big pictures go through `format: "rle"`

Plain characters cost one character per cell, and a call accepts **32,768 cells** that way
— counted as widest row × row count, so 200×200 is over the limit and 256×256 is double
it. Set `format: "rle"` and each row becomes **runs of an optional count then one
character**, so a 200×200 scene is one call and one undo step instead of two of each:

```js
draw_pixel_art({
  origin: [-100, -100],
  palette: { s: "#2d7ff9", g: "#45b86b", k: "#161616" },
  // 200x200 = 40,000 cells, about 1,500 characters on the wire.
  rows: [...Array(120).fill("200s"), ...Array(60).fill("200g"), ...Array(20).fill("80g40k80g")],
  format: "rle",
})
```

`12k8r.` is twelve `k`, eight `r`, one `.`. A run with no count is one cell, so `krw` is
three cells. `.` and `-` run like any other character.

| | `"chars"` | `"rle"` |
| --- | --- | --- |
| rows per call | 256 | 1024 |
| characters per row | 256 | 1024 |
| **cells per call** | **32,768** | **262,144** (512×512) |

**Digits are always run counts in `rle`,** so no palette key may be a digit there — the
call is rejected rather than misread. Digit keys are still fine in `"chars"`.

Two things still beat both encodings. `ops` is not counted against either cell cap, so a
solid sky is cheapest as `c #2d7ff9; rect -100 -100 99 -20 f`, a silhouette as one `poly`,
and a texture as one `fill`. And `mirror` halves anything symmetrical. Reach for `rle` for
the dense, irregular detail that is left over.

## Large geometry goes through `ops`

`ops` is a `;`-separated command string in absolute coordinates:

```
c #2d7ff9; rect -20 -20 20 20 f; bucket 0 0
```

- `c COLOR` — set the pen. `COLOR` is a palette key, a hex value, or `-` to erase.
- `px x y …` — individual cells.
- `line x0 y0 x1 y1`
- `rect x0 y0 x1 y1 [f]` / `ellipse x0 y0 x1 y1 [f]` — `f` fills.
- `poly x0 y0 x1 y1 x2 y2 … [f]` — closes back to the first point. **`f` fills it**, so any
  triangle or irregular silhouette is one op: a roof, a mountain, a fin, a hull.
- `path x0 y0 x1 y1 …` — the same, left open. For wires, horizons and ground lines.
- `fill x0 y0 x1 y1 checker A B [size]` / `fill x0 y0 x1 y1 dither A B [percent]` — writes a
  two-colour pattern over a whole rectangle. `checker` takes a square size (default 1),
  `dither` an ordered-dither density from 0 to 100 (default 50). Both are anchored to
  absolute coordinates, so neighbouring fills tile without a seam.
- `bucket x y` — flood fill.
- `recolor from to x0 y0 x1 y1` — swap one colour for another inside a rectangle.

Up to 128 ops, 4000 characters. `px` takes up to 500 `x y` pairs, `poly` and `path` up to
64 points, and a single shape or `fill` covers up to 50,000 pixels. `rows` run first and
later writes win, so one call can stamp a sprite and then rule a line across it.

A filled `poly` is always stroked as well as filled, so a shape keeps a crisp edge and a
spur too thin to enclose any cells still shows up. That whole mountain scene — dithered
sky, two filled peaks, a snow cap, an open ground line and a tiled foreground — is 255
characters of `ops` and 947 pixels:

```
c #2d7ff9;fill -20 -12 19 -2 dither #2d7ff9 #f5f1e8 25;
c #7557d3;poly -20 8 -8 -6 2 8 f;
c #45b86b;poly -2 8 8 -10 18 8 f;
c #161616;path -20 9 -10 9 -6 11 4 11 8 9 19 9
```

`mirror` (`"left-right"`, `"top-bottom"`, `"both"`) repeats everything the call draws
across the canvas centre — draw half a symmetrical thing and let the tool write the
other half.

**One call is one undo step.** A call whose input is invalid changes nothing at all.

Pass `dryRun: true` to validate and price a call without drawing it: you get the same
`painted`, `erased`, `clipped`, `bounds`, warnings and hint, but no pixels change and no
undo step is added. Every limit, palette key and coordinate is checked, so it is the cheap
way to confirm a big call before committing it — and the person sees nothing, because
nothing happened.

## Seeing what you drew

Tool results give you counts and bounds, which tell you a call landed but not whether it
looks right. Pass `shade: true` to `read_canvas` for a `shaded` thumbnail: at most 48
characters a side, drawn `.:-=+*#%@` from dark to light with a space for empty. Rows tell
you *which* colour a cell is; `shaded` tells you *how light* it is, so the picture reads as
a picture:

```
|................................@@......|   <- moon
|.......................@@...............|
|.....................::::::.............|   <- peaks
|    ::::::::::   ::::::::::::::         |
|----------------------------------------|   <- ground
|-..-.--.-..-.--.-..-.--.-..-.--.-..-.--.|   <- textured foreground
```

It is a thumbnail, so it has a thumbnail's limits: two colours of similar lightness land on
the same character however different their hues are, and sparse detail inside a block loses
to the block's dominant colour. Use it to judge composition, balance and silhouette — then
`read_canvas` without `shade` when you need the actual colours, or `export_pixel_art` when
the person wants the real image.

## Read before you redraw

`read_canvas` returns `{origin, palette, rows}` in the same shape `draw_pixel_art` takes,
so read → edit the rows → draw them back is a closed loop with no reformatting. Two
things to watch:

- In a read, `.` means **empty**. Drawn back, `.` means **keep what is there**. To clear
  a cell you have to write `-`.
- **Check `format` before you read the rows.** A read returns `"chars"` or `"rle"`, in the
  same two encodings `draw_pixel_art` accepts, and picks whichever describes the region
  best. Feed `format` straight back with the rows and the loop closes either way.
- A region up to 64×64 comes back as plain characters at native resolution. Larger regions
  come back as **exact `rle`** when they compress inside the read budget — up to 262,144
  cells, so a flat or sparse 200×200 scene reads back perfectly — and are block-downscaled
  only when they do not. An omitted `region` is capped tighter still, at 48 characters a
  side, since it can span the whole canvas.
- `exact` is `true` only when **both** conditions hold: `scale` is 1, *and* the region holds
  at most 52 distinct colours. Past 52, the rare ones fold into the nearest colour that was
  kept and `folded` counts them. So a 40×40 region with 80 colours reads at native
  resolution and is still not exact.
- If `exact` is false, treat the rows as an overview and read smaller regions in turn
  before relying on them. Detailed or dithered art is what fails to compress, so that is
  where tiled reads are still needed.

Omit `region` for an overview of everything painted.

### A read is also how you learn the state

Every read carries more than rows, and the numbers stay **exact even when the rows do
not** — they are counted over raw cells, not over the downscaled blocks:

| field | what it tells you |
| --- | --- |
| `painted` / `empty` | exact cell counts inside the region |
| `colors` | the 16 most used colours with exact counts, `distinctColors` for the true total |
| `art` / `paintedTotal` | bounds and cell count for everything on the canvas, not just the region |
| `selection` | what the person has selected |
| `view` | where they are looking |
| `history` | `{undo, redo}` depth, so you know how far back a mistake can be walked |
| `limits` | every cap in one object — `maxCellsPerDraw`, `maxRows`, `maxRowLength`, `maxOps`, `maxPxPairs`, `maxShapePixels`, `exactReadSize`, `exactReadColors`, and the rest |

So **read once before a large draw.** A single read tells you the real cell cap, how much
of your target area is already painted, and which colours are in play — none of which you
should be discovering from a rejected 40,000-cell write.

## Rearrange with `selection`, not by redrawing

`selection` costs no pixel data at all. `op` is one of `set`, `dismiss`, `erase`,
`duplicate`, `move`, `copy`, `cut`, `paste`, `flip-left-right`, `flip-top-bottom`,
`rotate` (90° clockwise). `to` is the **absolute** top-left corner of the target, not an
offset, and `duplicate` takes `times` (up to 64) to lay down a whole row of copies in one
call, each repeating the offset of the first.

`region` defaults to whatever the person has selected, so omit it when they said "this"
and pass it explicitly when they did not.

## Working alongside the person

- The undo timeline is shared. `edit({op: "undo"})` can undo *their* stroke — only reach
  for it when they asked.
- Your actions show up in a notice feed under the header, and the view eases over to
  frame edits you make off screen, so you do not need `view` to make your work visible.
  Use `view` only for navigation the person asked for.
- `view` refuses while the person is mid-stroke; wait a moment and try again.
- `draw_pixel_art` may return a single `hint` when the same result had a much cheaper
  form — a mirrored half, one filled rect. It is advice about your *next* call; the call
  you made still did exactly what you asked.
- `export_pixel_art` writes a file into the person's downloads. Ask first.

## Where the rest lives

- Agent guide: <https://mcpixels.app/llms.txt>
- Server card: <https://mcpixels.app/.well-known/mcp/server-card.json>
- Authentication (there is none): <https://mcpixels.app/auth.md>
