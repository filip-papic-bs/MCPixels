import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MCP_PATH, TAIL_PATH, WORDMARK_WIDTH } from "./wordmark-paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const SOURCE = join(HERE, "..", "design", "mascot.png");

const INK = "#1a1b19";
const PAPER = "#fafaf7";
const MUTED = "#5c5f59";
const ACCENT = "#ef5938";

const rect = (x, y, w, h, fill, extra = "") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;

async function contentBox() {
  const { data, info } = await sharp(SOURCE).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * channels + 3] <= 8) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

async function squareIcon(size, box, { background, margin = 0.04 }) {
  const inner = Math.round(size * (1 - margin * 2));
  const sprite = await sharp(SOURCE)
    .extract(box)
    .resize(inner, inner, { fit: "inside", kernel: "lanczos3" })
    .toBuffer();
  const { width, height } = await sharp(sprite).metadata();
  return sharp({
    create: { width: size, height: size, channels: 4, background },
  })
    .composite([
      {
        input: sprite,
        left: Math.round((size - width) / 2),
        top: Math.round((size - height) / 2),
      },
    ])
    .png();
}

/** The header logotype, from baked Syne outlines. `em` is the type size in px. */
function logotype(x, baseline, em, tailFill) {
  const scale = em / 100;
  return (
    `<g transform="translate(${x} ${baseline}) scale(${scale})">` +
    `<path d="${MCP_PATH}" fill="${ACCENT}"/>` +
    `<path d="${TAIL_PATH}" fill="${tailFill}"/>` +
    `</g>`
  );
}

async function socialCard(box) {
  const width = 1200;
  const height = 630;

  // Ink at low opacity, since the card is paper rather than dark.
  let grid = "";
  for (let x = 0; x <= width; x += 30) grid += rect(x, 0, 1, height, INK, ' opacity="0.055"');
  for (let y = 0; y <= height; y += 30) grid += rect(0, y, width, 1, INK, ' opacity="0.055"');

  // Mascot on the left, logotype on the right, the pair centred as one unit.
  const spriteHeight = 380;
  const spriteWidth = Math.round((box.width / box.height) * spriteHeight);
  const gap = 84;
  const em = 88;
  const wordWidth = (WORDMARK_WIDTH * em) / 100;
  const lockupX = Math.round((width - (spriteWidth + gap + wordWidth)) / 2);
  const textX = lockupX + spriteWidth + gap;

  const baseline = 302;
  const type = (y, content) =>
    `<text x="${textX}" y="${y}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="25" fill="${MUTED}" letter-spacing="0.5">${content}</text>`;

  const card =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">` +
    rect(0, 0, width, height, PAPER) +
    grid +
    rect(textX, 342, Math.round(wordWidth), 2, INK, ' opacity="0.16"') +
    `<g shape-rendering="geometricPrecision">` +
    logotype(textX, baseline, em, INK) +
    type(384, "A pixel canvas people and AI agents") +
    type(418, "edit together, live, in the browser.") +
    `</g></svg>`;

  const sprite = await sharp(SOURCE).extract(box).resize(spriteWidth, spriteHeight, { kernel: "lanczos3" }).toBuffer();

  return sharp(Buffer.from(card))
    .composite([{ input: sprite, left: lockupX, top: Math.round((height - spriteHeight) / 2) }])
    .png();
}

function icoFromPngs(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = header.length + images.length * 16;
  const entries = [];
  for (const { png, size } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

const box = await contentBox();

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

const ico = [];
for (const size of [48, 32, 16]) {
  ico.push({ size, png: await (await squareIcon(size, box, { background: TRANSPARENT })).toBuffer() });
}
writeFileSync(join(PUBLIC, "favicon.ico"), icoFromPngs(ico));

await (await squareIcon(180, box, { background: { r: 250, g: 250, b: 247, alpha: 1 }, margin: 0.06 }))
  .flatten({ background: PAPER })
  .removeAlpha()
  .toFile(join(PUBLIC, "apple-touch-icon.png"));

await (await squareIcon(192, box, { background: TRANSPARENT, margin: 0.06 })).toFile(join(PUBLIC, "icon-192.png"));

await (await socialCard(box)).toFile(join(PUBLIC, "og.png"));

console.log(
  `Wrote favicon.ico (48/32/16), apple-touch-icon.png, icon-192.png, og.png ` +
    `from a ${box.width}x${box.height} crop of design/mascot.png`,
);
