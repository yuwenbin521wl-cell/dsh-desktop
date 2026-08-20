/**
 * 纯 Node 生成 256x256 PNG 应用图标（无第三方依赖）：深蓝渐变圆角方块 +
 * 白色对话气泡 + 内圆点，作为 electron-builder 的 win.icon 输入
 * （electron-builder 会自行把 PNG 转成 .ico）。
 * @module dsh-desktop/make-icon
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** 圆角矩形 SDF：>0 在外部，<0 在内部。 */
function roundedRectSdf(x: number, y: number, w: number, h: number, r: number): number {
  const qx = Math.abs(x - w / 2) - (w / 2 - r)
  const qy = Math.abs(y - h / 2) - (h / 2 - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

/** 圆形 SDF。 */
function circleSdf(x: number, y: number, cx: number, cy: number, r: number): number {
  return Math.hypot(x - cx, y - cy) - r
}

/** 在 outPath 写一张 size x size 的 RGBA PNG。 */
export function generateIcon(outPath: string, size = 256): void {
  const radius = size * 0.22
  const gradient = (x: number, y: number): [number, number, number] => {
    const t = (x + y) / (2 * size)
    const lerp = (a: number, b: number): number => Math.round(a + (b - a) * t)
    // 顶部浅蓝 #5B7CFA → 底部深蓝 #3A5BFA
    return [lerp(0x5b, 0x3a), lerp(0x7c, 0x5b), lerp(0xfa, 0xfa)]
  }
  const bubbleCx = size * 0.5
  const bubbleCy = size * 0.44
  const bubbleR = size * 0.24
  const dotR = size * 0.10
  const pixel = (x: number, y: number): [number, number, number, number] => {
    const edge = roundedRectSdf(x + 0.5, y + 0.5, size, size, radius)
    const alpha = Math.max(0, Math.min(1, 0.5 - edge))
    if (alpha <= 0) return [0, 0, 0, 0]
    let [r, g, b] = gradient(x, y)
    if (circleSdf(x + 0.5, y + 0.5, bubbleCx, bubbleCy, bubbleR) < 0) {
      ;[r, g, b] = [255, 255, 255]
    }
    if (circleSdf(x + 0.5, y + 0.5, bubbleCx, bubbleCy, dotR) < 0) {
      ;[r, g, b] = [0x46, 0x64, 0xfa]
    }
    return [r, g, b, Math.round(alpha * 255)]
  }

  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y)
      const off = y * stride + 1 + x * 4
      raw[off] = r
      raw[off + 1] = g
      raw[off + 2] = b
      raw[off + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, png)
  console.log(`[make-icon] wrote ${outPath} (${size}x${size})`)
}
