// 本地测试更新流程用的最小 generic 更新源。
// 用法：node scripts/dev-update-feed.mjs
// 然后另开终端：DSH_DESKTOP_UPDATE_URL=http://127.0.0.1:8899 npm run dev
// （或把 dev-app-update.yml.example 复制为 dev-app-update.yml 后直接 npm run dev）
// 默认投递 2MB 伪安装包（只验证提示/下载流程）；设 DSH_DESKTOP_FEED_FILE 指向
// 真实安装包即可验证"立即重启后安装器真正执行"的完整更新（版本号仍用 FEED_VERSION）。
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

const PORT = Number(process.env.PORT ?? 8899)
// 模拟“下一个真实发布版本”：演示更新流程时对话框显示的就是这个版本号。
// 真实发布场景请用 FEED_VERSION 指向实际新版本，或直接使用 GitHub Releases 更新源。
const VERSION = process.env.FEED_VERSION ?? '0.1.0-rc.6'

const REAL_FILE = process.env.DSH_DESKTOP_FEED_FILE
let payload
let FILE_NAME
if (REAL_FILE !== undefined && REAL_FILE !== '' && existsSync(REAL_FILE)) {
  payload = readFileSync(REAL_FILE)
  FILE_NAME = basename(REAL_FILE)
  console.log(`[feed] serving REAL installer ${REAL_FILE} (${payload.length} bytes)`)
} else {
  payload = Buffer.alloc(2 * 1024 * 1024, 0xab)
  FILE_NAME = `DeepSeek Harness Setup ${VERSION}.exe`
}
const sha512 = createHash('sha512').update(payload).digest('base64')

const latestYml = [
  'version: ' + VERSION,
  'files:',
  '  - url: ' + FILE_NAME,
  '    sha512: ' + sha512,
  '    size: ' + String(payload.length),
  'path: ' + FILE_NAME,
  'sha512: ' + sha512,
  "releaseDate: '2026-01-01T00:00:00.000Z'",
  '',
].join('\n')

createServer((req, res) => {
  console.log('[feed]', req.method, req.url)
  // electron-updater 会带 ?noCache=... 查询串请求 latest.yml，且文件名中的空格
  // 会被编码成 %20：先剥离查询串，再 URL 解码后匹配。
  const pathname = decodeURIComponent((req.url ?? '').split('?')[0])
  if (pathname === '/latest.yml') {
    res.writeHead(200, { 'content-type': 'text/yaml' })
    res.end(latestYml)
  } else if (pathname === '/' + FILE_NAME) {
    res.writeHead(200, { 'content-length': payload.length })
    res.end(payload)
  } else {
    res.writeHead(404)
    res.end('not found')
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`dev update feed listening on http://127.0.0.1:${PORT}`)
  console.log(`serving version ${VERSION} (${FILE_NAME})`)
})
