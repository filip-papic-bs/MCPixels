# MCPixels

A 1024 by 1024 pixel-art canvas that a human and an AI agent can co-edit on the same live page, via WebMCP (`document.modelContext.registerTool`) — no backend, just page-native tools an agent's browser can call directly.

Built as an entry for OpenAI's WebMCP hackathon. Details: https://webmcp.devpost.com/

The site also publishes static agent-discovery documents (`/.well-known/*`, `/llms.txt`,
`/index.md`, `/auth.md`) and `Link` headers — see **Agent discovery** in `README.md`
before touching `public/_headers`, `public/robots.txt` or anything under
`public/.well-known/`.
