/**
 * 【已弃用】旧的点阵锁形托盘图标生成脚本。
 * 现在用 `swift scripts/gen-icons.swift` 生成「密」字托盘图与客户端图标，
 * 重跑本脚本会把菜单栏图标覆盖回锁形，请勿再执行。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron');

const GLYPH = [
  '................',
  '................',
  '.....XXXXXX.....',
  '....X......X....',
  '....X......X....',
  '....X......X....',
  '..XXXXXXXXXXXX..',
  '..XXXXXXXXXXXX..',
  '..XXXX....XXXX..',
  '..XXXX....XXXX..',
  '..XXXXXXXXXXXX..',
  '..XXXXXXXXXXXX..',
  '..XXXXXXXXXXXX..',
  '................',
  '................',
  '................',
];

/** 把字符画按 scale 放大成 RGBA 像素缓冲（X=黑色不透明，其余透明） */
function render(rows, scale) {
  const w = rows[0].length * scale;
  const h = rows.length * scale;
  const raw = Buffer.alloc((w * 4 + 1) * h); // 每行行首 +1 字节过滤器（0）
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: None
    const srcY = Math.floor(y / scale);
    for (let x = 0; x < w; x++) {
      const on = rows[srcY][Math.floor(x / scale)] === 'X';
      raw[o++] = 0;
      raw[o++] = 0;
      raw[o++] = 0;
      raw[o++] = on ? 255 : 0;
    }
  }
  return { w, h, raw };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng({ w, h, raw }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'trayTemplate.png'), encodePng(render(GLYPH, 1)));
writeFileSync(path.join(dir, 'trayTemplate@2x.png'), encodePng(render(GLYPH, 2)));
console.log('已生成 electron/trayTemplate.png 与 trayTemplate@2x.png');
