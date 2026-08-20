/**
 * 把 .runtime（独立 node.exe + dsh-deploy 运行时树）打成发布产物：
 *   desktop/release/dsh-runtime-v<version>.zip
 * 版本取 .runtime/dsh-deploy/node_modules/@deepseek-ai/dsh/package.json 的 version。
 * 该 zip 随 GitHub Releases 发布后，桌面版的“检查引擎更新…”就能发现并更新引擎。
 * 用法：tsx scripts/build-runtime-zip.ts（须先 npm run prepare:runtime）
 * @module dsh-desktop/build-runtime-zip
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const scriptsDir = __dirname
const desktopRoot = resolve(scriptsDir, '..')
const runtimeDir = join(desktopRoot, '.runtime')
const releaseDir = join(desktopRoot, 'release')

function main(): void {
  const manifestPath = join(runtimeDir, 'dsh-deploy', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!existsSync(manifestPath)) {
    console.error('[build-runtime-zip] 缺少运行时，请先运行 npm run prepare:runtime')
    process.exit(1)
  }
  const version = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }).version
  if (typeof version !== 'string' || version === '') {
    console.error('[build-runtime-zip] 无法读取运行时版本')
    process.exit(1)
  }
  mkdirSync(releaseDir, { recursive: true })
  const out = join(releaseDir, `dsh-runtime-v${version}.zip`)
  console.log(`[build-runtime-zip] packing ${runtimeDir} -> ${out} (version ${version})`)
  const result = spawnSync('tar', ['-a', '-c', '-f', out, '-C', runtimeDir, '.'], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`[build-runtime-zip] tar 打包失败（exit ${result.status ?? 'null'}）`)
    process.exit(1)
  }
  const sha256 = createHash('sha256').update(readFileSync(out)).digest('hex')
  writeFileSync(`${out}.sha256`, sha256)
  console.log(`[build-runtime-zip] done: ${out}`)
  console.log(`[build-runtime-zip] sha256: ${sha256}`)
}

main()
