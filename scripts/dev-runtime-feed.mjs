// 本地测试“dsh 引擎更新”通道用的最小更新源（generic 模式，DSH_DESKTOP_RUNTIME_URL）。
// 用法：
//   node scripts/dev-runtime-feed.mjs   （默认 8898 端口，version 0.1.0-rc.6）
// 环境变量：
//   PORT                 监听端口，默认 8898
//   FEED_VERSION         声称的新引擎版本，默认 0.1.0-rc.6
//   DSH_RUNTIME_FEED_ZIP 指向真实 dsh-runtime zip（默认 release/dsh-runtime-v0.1.0-rc.5.zip）
// 然后带引擎源启动应用：DSH_DESKTOP_RUNTIME_URL=http://127.0.0.1:8898 <应用>
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PORT = Number(process.env.PORT ?? 8898)
const VERSION = process.env.FEED_VERSION ?? '0.1.0-rc.6'
const DEFAULT_ZIP = resolve(import.meta.dirname, '..', 'release', 'dsh-runtime-v0.1.0-rc.5.zip')
const ZIP_PATH = process.env.DSH_RUNTIME_FEED_ZIP ?? DEFAULT_ZIP

if (!existsSync(ZIP_PATH)) {
  console.error(`[runtime-feed] zip 不存在：${ZIP_PATH}（请先 npm run build:runtime-zip）`)
  process.exit(1)
}
const zip = readFileSync(ZIP_PATH)
const sha256 = createHash('sha256').update(zip).digest('hex')
const ZIP_NAME = `dsh-runtime-v${VERSION}.zip`
const latestJson = JSON.stringify({ version: VERSION, url: ZIP_NAME, sha256 })

createServer((req, res) => {
  const pathname = decodeURIComponent((req.url ?? '').split('?')[0])
  console.log('[runtime-feed]', req.method, req.url)
  if (pathname === '/latest.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(latestJson)
  } else if (pathname === '/' + ZIP_NAME) {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length })
    res.end(zip)
  } else {
    res.writeHead(404)
    res.end('not found')
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`dev runtime feed listening on http://127.0.0.1:${PORT}`)
  console.log(`serving engine ${VERSION} (${ZIP_NAME}, sha256 ${sha256.slice(0, 16)}…)`)
})
