# MCPixels

A 1024×1024 pixel-art canvas that a person and an AI agent edit together, live, on the same page.

The editor is an ordinary pixel editor in any browser — draw, shapes, fill, selections, mirroring, import, PNG export, undo. In a WebMCP browser it also hands an agent **six site tools** covering everything but image import, so the agent is a real participant rather than a pixel pipe. No backend: the tools are registered by the page itself via `document.modelContext.registerTool`.

Built for [OpenAI's WebMCP Challenge](https://webmcp.devpost.com/). Live at **[mcpixels.app](https://mcpixels.app/)**.

## Run locally

Requires Node 24+ — `npm test` runs `.ts` files directly, which needs unflagged native type stripping (Node 23.6 or later).

```bash
npm install
npm run dev      # vite dev server
npm test         # pure logic, node:test, no test dependency installed
npm run build    # tsc --noEmit && vite build
npm run lint     # Biome lint checks
npm run format   # format source and config files
npm run check    # format/lint gate, tests, typecheck and production build
```

`npm test` covers the canvas primitives (`src/pixels.ts`), the agent wire format (`src/agent/encode.ts`), and the six tools driven against a stand-in editor (`src/tools.test.ts`).

To exercise the agent side:

- **ChatGPT** — open the site in the ChatGPT desktop app's built-in browser, then check **Site tools** in the address bar.
- **Chrome 146+** — enable `chrome://flags/#enable-webmcp-testing`, then from the console: `navigator.modelContext.getTools()` and `executeTool("draw_pixel_art", { … })`.

## The six tools

The whole surface costs **~1,260 tokens** of context, because every tool's description and schema sits in the model's context on every turn. That budget is the reason for most of the design below.

| # | tool | what it does |
| --- | --- | --- |
| 1 | `draw_pixel_art` | The only tool you send pixel data to. Takes a picture (`rows` of palette characters), a command string (`ops` — line, rect, ellipse, flood fill, recolour, pixels), or both, plus optional `mirror`. One call is one undo step, unless it changed nothing. |
| 2 | `read_canvas` | Reads any region back in exactly the format `draw_pixel_art` accepts, with an `exact` flag saying whether the rows are faithful. A read costs at most ~2,600 tokens whatever is on the canvas. |
| 3 | `selection` | Rearranges art already on the canvas: `duplicate` (with `times`, for a row in one call), `move`, `erase`, `flip-left-right`, `flip-top-bottom`, `rotate`, `copy`/`cut`/`paste`, `set`/`dismiss`. Takes an explicit region, falling back to the person's selection when you omit one. No pixel data travels through it. |
| 4 | `edit` | `undo`, `redo` (up to 20 steps at once), or `clear-canvas`. The agent and the person share one edit timeline. |
| 5 | `view` | Frames a region on screen. Draws nothing — edits bring themselves into view on their own, so this is only for navigation the person asked for. |
| 6 | `export_pixel_art` | Saves a region as a PNG to the person's downloads at a chosen scale. |

### Why pictures instead of coordinates

Sending a 32×32 sprite as `[{x, y, color}, …]` costs about 22,500 tokens. As rows of palette characters it costs about 400 — and the agent can see what it is writing:

```js
draw_pixel_art({
  origin: [-4, -3],
  palette: { k: "#161616", r: "#ff5c35", w: "#f5f1e8" },
  rows: ["..kkkk..", ".krrrrk.", "kr.ww.rk", "krrrrrrk", ".kkkkkk."],
})
```

`.` leaves a cell alone, `-` erases it — stamping never scrubs the art underneath. Larger geometry goes through `ops` instead — `c #2d7ff9;rect -20 -20 20 20 f;bucket 0 0` — and both can be combined in one call. Because `read_canvas` returns the same shape, read → edit the rows → draw back is a closed loop with no reformatting.

The tools also nudge the agent toward the editor's own capabilities rather than spelling out every pixel: `draw_pixel_art` may return a single `hint` when a call had a substantially cheaper form (a mirrored half, or one filled rect). It is advice only — every call always does exactly what was asked.

### Watching the agent work

Agent actions appear in a notice feed under the header; the person's own edits stay out of it. When an agent draws off screen the view eases across to frame it and the area flashes, so its work is not invisible — skipped while you are mid-gesture or have the import or export panel open, and switched off entirely with **Follow agent edits** in the dock's ••• menu.

## Layout

```
src/
  pixels.ts        pure canvas logic: history, geometry, fill, RLE persistence
  agent/           encode.ts (wire format) · tools.ts (the six) · controller.ts
  editor/          state provider, hooks — pointer machine, keyboard, panels
  render/          canvas painter and PNG rasterizer, no React
  components/      presentational UI · icons.tsx (generated)
```

## Icons

Most of the chrome uses hand-drawn stroke icons, written inline where they are
used. Seven come from [Material Symbols][ms] Sharp, weight 400, optical size 24,
inlined as paths in `src/components/icons.tsx`:

- **the shape picker and the button that opens it** — line, rectangle, ellipse
  and their filled cuts, where the icon *is* the shape and drawing it by hand
  only invites inconsistency
- **the pan tool** — `open_with`, four-way arrows. Deliberately not a hand:
  every hand in this pack is built from a hooked L-shaped palm plus three
  detached bars for fingers, and at 23px that reads as a comb. `pan_tool`,
  `pan_tool_alt`, `back_hand`, `front_hand` and `hand_gesture` all share the
  construction, and the filled cuts collapse into a blob.

Nothing is loaded at runtime: no icon font, no network request, no flash of
missing glyphs. Those glyphs are filled paths rather than strokes, so they carry
an `icon` class that the stylesheet uses to exempt them from the surrounding
stroke treatment — keep the class if you add more.

`icons.tsx` is generated. To add or swap one, edit the `ICONS` map in
`scripts/fetch-ui-icons.mjs` and re-run it:

```bash
node scripts/fetch-ui-icons.mjs
```

It refuses any glyph that does not arrive as a single path on the pack's
standard `0 -960 960 960` viewBox, so a bad name fails loudly rather than
shipping a blank button. The outline and filled cuts of the rectangle and
ellipse share a bounding box exactly, so a shape does not jump size when you
switch its style.

One glyph is turned in CSS rather than substituted: the pack ships no diagonal
rule, so `horizontal_rule` is rotated -45° into the shape picker's line. It is
symmetric about the turn, so the rotation is invisible.

Material Symbols is Apache-2.0 licensed by Google.

[ms]: https://github.com/google/material-design-icons

## Agent discovery

The site advertises itself to agents and registries through static documents in
`public/` plus `Link` response headers in `public/_headers`. Everything here is a
file on the CDN — no Functions, nothing to run.

| path | what it is |
| --- | --- |
| `/.well-known/api-catalog` | RFC 9727 linkset, `application/linkset+json` |
| `/.well-known/mcp/server-card.json` | MCP server card (SEP-1649) for the in-page WebMCP server |
| `/.well-known/ai-catalog.json` | ARD capability manifest, CORS-open |
| `/.well-known/agent-skills/index.json` | Agent Skills Discovery index v0.2.0, generated |
| `/.well-known/agent-skills/drawing-on-mcpixels/SKILL.md` | the skill itself |
| `/llms.txt` | short orientation for agents |
| `/index.md` | the homepage as markdown |
| `/auth.md` | states that there is no authentication, and why |
| `/robots.txt` | `Content-Signal` preferences and an `Agentmap` pointer |

`Link:` headers on `/` and `/index.html` carry `api-catalog`, `service-desc`,
`service-doc`, `alternate` (the markdown) and `describedby`; `<head>` repeats the
same set as `<link rel>` elements for clients that only parse the body.

The skills index is regenerated by the first step of `npm run build`, so a
SKILL.md edit updates its `sha256` digest:

```bash
node scripts/build-agent-skills-index.mjs
```

**No OAuth or OIDC metadata is published**, deliberately. There is no protected
resource, no authorization server and no issuer here, so
`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`
and `/.well-known/openid-configuration` would only send agents chasing endpoints
that do not exist. `/auth.md` says so in prose instead.

**Markdown content negotiation is not implemented.** Returning markdown for
`Accept: text/markdown` needs code on the request path, which this project does
not have; `/index.md` is served as a plain document and linked as
`rel="alternate"` instead. Cloudflare's zone-level [Markdown for Agents][mfa]
setting would add real negotiation without any Functions, if it is ever wanted.

[mfa]: https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/

### DNS records to add by hand

Two discovery mechanisms live in DNS rather than in this repo, so they have to be
added in the Cloudflare dashboard for `mcpixels.app`:

```dns
; ARD — points registries at the capability manifest (TXT)
_catalog._agents.mcpixels.app. 3600 IN TXT "url=https://mcpixels.app/.well-known/ai-catalog.json"

; DNS-AID — ServiceMode HTTPS record for the agent entrypoint
_index._agents.mcpixels.app. 3600 IN HTTPS 1 mcpixels.app. alpn="h2,http/1.1" port=443
```

The DNS-AID draft also defines a `well-known=` SvcParam pointing at the card
(`well-known=mcp/server-card.json`); until IANA assigns it a number it has to be
written as an experimental `keyNNNNN=` pair, which the Cloudflare DNS UI may not
accept. The record above is the part that validates today. `mcpixels.app` is on
Cloudflare DNS, so DNSSEC is one toggle in **DNS → Settings**.

## Deploy

Static Cloudflare Pages. No Pages Functions, no usage-billed services.

```bash
npm run deploy
```

Typechecks, builds, and uploads `dist` to the `mcpixels` Pages project on `main`.

## License

[GNU AGPL-3.0](LICENSE). Free to use, study, modify and share — but if you run a
modified version as a network service, section 13 requires you to offer its
source to the people using it.

Material Symbols is Apache-2.0 by Google; the glyphs inlined in
`src/components/icons.tsx` keep that license.
