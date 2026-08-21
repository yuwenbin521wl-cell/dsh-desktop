/**
 * 把桌面壳（shell）的版本号同步为内置引擎（bundled dsh engine）的版本号。
 *
 * 桌面版只是个壳，里面的引擎是官方 deepseek-harness（定期通过 engine-sync
 * 拉取）。壳的版本号不做自增，始终与拉取到的引擎版本保持一致：
 *   引擎 version（@deepseek-ai/dsh）→ package.json "version"
 * 这样安装包、更新 feed、latest.yml 的版本都跟引擎对齐。
 *
 * 用法：tsx scripts/sync-version.ts（须先 npm run prepare:runtime）
 * 在打包（dist / dist:publish / build:runtime-zip）前调用，保证产物版本一致。
 * @module dsh-desktop/sync-version
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const scriptsDir = __dirname
const desktopRoot = resolve(scriptsDir, '..')

function main(): void {
  const manifestPath = join(
    desktopRoot, '.runtime', 'dsh-deploy', 'node_modules', '@deepseek-ai', 'dsh', 'package.json',
  )
  let version: unknown
  try {
    version = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }).version
  } catch {
    console.error('[sync-version] 缺少运行时，请先运行 npm run prepare:runtime')
    process.exit(1)
  }
  if (typeof version !== 'string' || version === '') {
    console.error('[sync-version] 无法读取运行时版本')
    process.exit(1)
  }
  const pkgPath = join(desktopRoot, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
  if (pkg.version === version) {
    console.log(`[sync-version] version already ${version}, no change`)
    return
  }
  const previous = pkg.version
  pkg.version = version
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log(`[sync-version] shell version ${String(previous)} -> ${version}`)
}

main()
