# auth.md

**MCPixels needs no authentication.** There is nothing to register for, no token to
obtain, and no credential to send. If you are an agent looking for a way in: there is no
door, only the page.

## Who this is for

AI agents that want to use the tools on <https://mcpixels.app/>.

## How access actually works

MCPixels is a static site with no backend. Its six tools —
`draw_pixel_art`, `read_canvas`, `selection`, `edit`, `view`, `export_pixel_art` — are
**WebMCP site tools**: the page registers them with `document.modelContext.registerTool`
when it loads, and they run inside the browser tab the person is looking at.

So the access model is the tab itself:

1. The person opens <https://mcpixels.app/> in a browser that exposes WebMCP
   (the ChatGPT desktop app's built-in browser, or Chrome 149+ with
   `chrome://flags/#enable-webmcp-testing`).
2. The browser surfaces the page's tools to the agent attached to that tab.
3. The person's browser decides whether you may call them. That consent is the whole
   authorisation story.

The canvas lives in that tab. Nothing is stored on a server, no data is shared between
visitors, and no request you make can reach another person's canvas.

## Registration

None. There is no registration endpoint, and any URL that claims to be one is not ours.

## Credentials

None. Do not send `Authorization` headers, API keys or bearer tokens to `mcpixels.app` —
nothing reads them.

## Why there is no OAuth metadata

`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` and
`/.well-known/openid-configuration` are deliberately **not published**. There is no
protected resource, no authorization server and no issuer, so publishing that metadata
would only send agents chasing endpoints that do not exist.

## Limits and etiquette

- The canvas is shared with a person who is drawing on it right now. Their edits and
  yours are one undo timeline — do not `edit({op: "undo"})` past your own work.
- `export_pixel_art` writes a PNG into the person's downloads folder. Ask before you do.
- Everything else is reversible.

## Related documents

- Agent guide: <https://mcpixels.app/llms.txt>
- Server card: <https://mcpixels.app/.well-known/mcp/server-card.json>
- Capability manifest: <https://mcpixels.app/.well-known/ai-catalog.json>
- API catalog: <https://mcpixels.app/.well-known/api-catalog>
- Skills: <https://mcpixels.app/.well-known/agent-skills/index.json>
