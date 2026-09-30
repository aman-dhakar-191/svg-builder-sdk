// Renders the app icons from build/icon.svg (large sizes, with the pen path) and
// build/icon-small.svg (64 px and below, the C alone) into the files electron-builder
// uses: build/icon.ico (Windows), build/icon-mac.png (macOS, on Apple's icon grid) and
// build/icons/NxN.png (Linux). Run it after changing the logo; the outputs are committed.
//   node scripts/make-icons.mjs
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const build = fileURLToPath(new URL("../build/", import.meta.url));
const large = readFileSync(`${build}icon.svg`, "utf8");
const small = readFileSync(`${build}icon-small.svg`, "utf8");
const SMALL_MAX = 64;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();

/** PNG of `svg` at size x size; `inset` px of transparent margin on every side. */
async function png(svg, size, inset = 0) {
  await page.setViewportSize({ width: size, height: size });
  const inner = size - inset * 2;
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;position:absolute;left:${inset}px;top:${inset}px;width:${inner}px;height:${inner}px}</style>${svg}`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
const forSize = (size) => (size <= SMALL_MAX ? small : large);

// Linux: a set of sizes.
mkdirSync(`${build}icons`, { recursive: true });
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) writeFileSync(`${build}icons/${size}x${size}.png`, await png(forSize(size), size));

// macOS: Apple's grid puts the tile at 824 of 1024 px, leaving room for the shadow.
writeFileSync(`${build}icon-mac.png`, await png(large, 1024, 100));

// Windows: one .ico with PNG frames; small frames use the simple C.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = [];
for (const size of sizes) frames.push(await png(forSize(size), size));
const header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach((data, i) => {
  const e = 6 + 16 * i;
  const s = sizes[i] >= 256 ? 0 : sizes[i]; // 0 means 256
  header.writeUInt8(s, e);
  header.writeUInt8(s, e + 1);
  header.writeUInt8(0, e + 2); // palette
  header.writeUInt8(0, e + 3);
  header.writeUInt16LE(1, e + 4); // planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(data.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
writeFileSync(`${build}icon.ico`, Buffer.concat([header, ...frames]));

await browser.close();
console.log(`Wrote build/icon.ico (${sizes.join(", ")} px), build/icon-mac.png and build/icons/.`);
