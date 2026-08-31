import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://mcpixels.app";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, "public", ".well-known", "agent-skills");

const SKILLS = [
  {
    name: "drawing-on-mcpixels",
    type: "skill-md",
    file: "drawing-on-mcpixels/SKILL.md",
    description:
      "Draw, read back and rearrange pixel art on mcpixels.app through its six in-page WebMCP tools, using the rows-and-palette wire format instead of per-pixel coordinates.",
    version: "0.1.0",
    license: "AGPL-3.0-or-later",
  },
];

const skills = await Promise.all(
  SKILLS.map(async ({ file, ...skill }) => {
    const bytes = await readFile(path.join(SKILLS_DIR, file));
    return {
      ...skill,
      url: `${ORIGIN}/.well-known/agent-skills/${file}`,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.byteLength,
    };
  }),
);

const index = {
  $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  version: "0.2.0",
  publisher: {
    name: "MCPixels",
    url: `${ORIGIN}/`,
  },
  skills,
};

const out = path.join(SKILLS_DIR, "index.json");
await writeFile(out, `${JSON.stringify(index, null, 2)}\n`);
console.log(`agent-skills index: ${skills.length} skill(s) → ${path.relative(ROOT, out)}`);
