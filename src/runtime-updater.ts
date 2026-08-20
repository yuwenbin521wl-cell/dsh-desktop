/**
 * dsh 引擎（运行时）更新通道：与桌面版（壳）更新完全独立。
 *
 * 源：
 * - 默认：官方仓库 deepseek-ai/deepseek-harness 的 GitHub Releases 最新版，
 *   查找资产 `dsh-runtime-v<version>.zip`（由发布流程构建上传）。
 * - 覆盖：环境变量 DSH_DESKTOP_RUNTIME_URL 指向自建静态源，GET <url>/latest.json
 *   返回 { "version": "0.1.0-rc.7", "url": "dsh-runtime-v0.1.0-rc.7.zip", "sha256": "..." }。
 *
 * 流程：检查 → 发现新版 → 询问是否更新 → 下载 zip → sha256 校验 → bsdtar 解压
 * 到 <userData>/runtime-v<version> → 写 runtime-state.json → 询问是否重启。
 * 重启后 runtime.ts 优先使用 userData 中的新运行时；壳更新（NSIS 覆盖安装）
 * 不会触碰 userData，因此两条更新通道互不干扰。
 * @module dsh-desktop/runtime-updater
 */

import { app, dialog } from 'electron'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { currentDshVersion, readRuntimeState, resolveRuntimeRoot, rmRuntimeDir, writeRuntimeState, bundledDshVersion, removeRuntimeState } from './runtime'
import { diag } from './diag'
import { t } from './i18n'

/** 官方 npm 上 @deepseek-ai/dsh 的最新版查询（真正的官方发布节奏）。 */
const NPM_DSH_LATEST = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest'

/** 引擎 zip 发布的 GitHub 仓库（owner/repo），仅 DSH_DESKTOP_RUNTIME_URL 自建源模式使用。 */
const RUNTIME_RELEASE_REPO = 'yuwenbin521wl-cell/dsh-desktop'

/** 自动检查间隔：6 小时。 */
const AUTO_CHECK_INTERVAL_MS = 6 * 3600 * 1000

/** 启动后首次自动检查延迟：12 秒。 */
const FIRST_CHECK_DELAY_MS = 12 * 1000

/** 引擎更新信息。 */
interface RuntimeUpdateInfo {
  version: string
  /** 'npm'：直接从官方 npm 安装（默认，无需中转仓库）；'zip'：自建源下载 zip。 */
  kind: 'npm' | 'zip'
  /** zip 方式时的下载地址（npm 方式为空）。 */
  url: string
  /** 小写 hex sha256；zip 方式使用，为空则跳过校验。 */
  sha256: string
}

/** 手动检查是否在等待结果。 */
let manualCheckPending = false

/** 更新流程是否进行中（防单实例内重入）。 */
let updating = false

/**
 * 获取跨进程更新锁：引擎更新下载/解压/替换期间，其它实例（包括重启后的新
 * 实例）的自动检查会拿到 false 而跳过，避免多个流程并发踩踏同一临时目录。
 * @returns 是否成功获得锁。
 */
function acquireUpdateLock(): boolean {
  const lock = join(app.getPath('userData'), 'runtime-update.lock')
  try {
    const fd = openSync(lock, 'wx')
    writeFileSync(fd, String(process.pid))
    closeSync(fd)
    return true
  } catch {
    return false
  }
}

/** 释放跨进程更新锁。 */
function releaseUpdateLock(): void {
  try {
    rmSync(join(app.getPath('userData'), 'runtime-update.lock'), { force: true })
  } catch {
    /* 忽略 */
  }
}

/**
 * 替换运行时目录前的主进程钩子：由 main.ts 注入，用于先停掉当前实例的
 * dsh 服务器（释放被占用文件的句柄，否则 Windows 上删除/重命名会 EPERM），
 * 并返回一个“恢复”函数：替换完成后若用户选择不重启，用它把服务器重新拉起
 * （此时会使用已更新的新引擎）。
 */
let preInstallHook: (() => Promise<(() => Promise<void>) | null>) | null = null

/** 注册替换前钩子（main.ts 调用）。 */
export function setRuntimePreInstallHook(hook: () => Promise<(() => Promise<void>) | null>): void {
  preInstallHook = hook
}

/** 简单的 semver 比较（支持 rc 等预发布标签）：candidate 是否比 current 新。 */
function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): [number[], string] => {
    const parts = v.split('-', 2)
    const core = parts[0] ?? '0'
    const pre = parts[1] ?? ''
    return [core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre]
  }
  const [cn, cp] = parse(candidate)
  const [rn, rp] = parse(current)
  for (let i = 0; i < 3; i++) {
    const a = cn[i] ?? 0
    const b = rn[i] ?? 0
    if (a !== b) return a > b
  }
  if (cp === rp) return false
  if (cp === '') return true // 稳定版 > 预发布
  if (rp === '') return false
  return cp > rp
}

/**
 * 解析最新引擎信息（按优先级）：
 * 1. 自建源（DSH_DESKTOP_RUNTIME_URL → latest.json，含 version/url/sha256）→ zip 方式；
 * 2. 默认：查询官方 npm @deepseek-ai/dsh 版本号，zip 下载地址按固定模式拼 GitHub
 *    Releases（由你仓库的 engine-sync 自动构建发布，全自动、~2 分钟更新）：
 *    https://github.com/<repo>/releases/download/dsh-engine-v<version>/dsh-runtime-v<version>.zip
 *    HEAD 探测 zip 存在才视为“可更新”（构建完成才提示，避免点了报 404）；
 * 3. DSH_DESKTOP_ENGINE_NPM=1 时走 npm 直装（官方直拉、无需中转，但较慢）。
 */
async function fetchRuntimeUpdateInfo(): Promise<RuntimeUpdateInfo | null> {
  const custom = process.env.DSH_DESKTOP_RUNTIME_URL
  if (custom !== undefined && custom !== '') {
    diag(`runtime feed: custom ${custom}`)
    const res = await fetch(`${custom}/latest.json`, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`引擎更新源返回 ${res.status}`)
    const data = await res.json() as { version?: unknown; url?: unknown; sha256?: unknown }
    if (typeof data.version !== 'string' || typeof data.url !== 'string') {
      throw new Error('引擎更新源格式错误（latest.json 需要 version/url 字段）')
    }
    const url = /^https?:\/\//.test(data.url) ? data.url : `${custom}/${data.url.replace(/^\//, '')}`
    return {
      version: data.version,
      kind: 'zip',
      url,
      sha256: typeof data.sha256 === 'string' ? data.sha256.toLowerCase() : '',
    }
  }
  // 官方 npm 版本信号：跟随官方发布节奏（频繁发布也能及时感知）。
  diag('runtime feed: official npm @deepseek-ai/dsh')
  const npmRes = await fetch(NPM_DSH_LATEST, { headers: { Accept: 'application/json' } })
  if (!npmRes.ok) throw new Error(`官方 npm 返回 ${npmRes.status}`)
  const npmData = await npmRes.json() as { version?: unknown }
  if (typeof npmData.version !== 'string' || npmData.version === '') {
    throw new Error('官方 npm 返回格式错误（缺少 version）')
  }
  const version = npmData.version
  if (process.env.DSH_DESKTOP_ENGINE_NPM === '1') {
    diag(`official engine version: ${version} (npm direct install)`)
    return { version, kind: 'npm', url: '', sha256: '' }
  }
  const repo = (process.env.DSH_DESKTOP_RUNTIME_REPO ?? RUNTIME_RELEASE_REPO).replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '')
  const rawUrl = `https://github.com/${repo}/releases/download/dsh-engine-v${version}/dsh-runtime-v${version}.zip`
  // 国内网络可设置 DSH_DESKTOP_GITHUB_PROXY（如 https://ghproxy.com/）加速 GitHub 下载。
  const proxy = process.env.DSH_DESKTOP_GITHUB_PROXY
  const url = proxy !== undefined && proxy !== '' ? `${proxy.replace(/\/$/, '')}/${rawUrl}` : rawUrl
  diag(`official engine version: ${version}; zip: ${url}`)
  // 探测 zip 是否已构建发布；构建完成才提示可更新（避免点了报 404）。
  let probe: Response
  try {
    probe = await fetch(url, { method: 'HEAD' })
  } catch (error) {
    throw new Error(`无法连接引擎更新源（${error instanceof Error ? error.message : String(error)}）。请检查网络；国内网络可设置 DSH_DESKTOP_RUNTIME_URL 或 DSH_DESKTOP_GITHUB_PROXY`)
  }
  if (probe.status === 404) {
    diag(`engine zip not built yet (${url}) — treat as no update`)
    return null
  }
  if (!probe.ok) throw new Error(`引擎更新包探测失败（${probe.status}）`)
  return { version, kind: 'zip', url, sha256: '' }
}

/**
 * 用内置 node + npm 在复制的运行时上直接安装官方 @deepseek-ai/dsh 包：
 * 复制当前生效运行时 → 注入 allowScripts → npm install @deepseek-ai/dsh@<version>
 * → 校验 → 替换为 userData/runtime-v<version> → 写状态。
 * @returns “恢复”函数（npm 方式无需停服务器，恒为 null）。
 */
async function installRuntimeFromNpm(info: RuntimeUpdateInfo): Promise<(() => Promise<void>) | null> {
  const userData = app.getPath('userData')
  const baseRoot = resolveRuntimeRoot()
  const target = join(userData, `runtime-v${info.version}`)
  const tmp = `${target}.tmp`
  rmRuntimeDir(tmp)
  diag(`cloning runtime ${baseRoot} -> ${tmp}`)
  cpSync(baseRoot, tmp, { recursive: true })

  const deployDir = join(tmp, 'dsh-deploy')
  const nodeExe = join(tmp, 'node', 'node.exe')
  const npmCli = join(tmp, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(nodeExe) || !existsSync(npmCli)) {
    rmRuntimeDir(tmp)
    throw new Error('运行时缺少 node/npm，无法直接安装官方引擎')
  }

  // 重写 dsh-deploy/package.json：只保留 @deepseek-ai/dsh 的官方 registry 依赖，
  // 移除 prepare 时的 file: tarballs 引用（否则 npm install 官方版本会被 file:
  // 依赖顶住、装不进新版本）。npm install 会按官方闭包重建 node_modules。
  // npm 11+ 的 allowScripts 同时写进去，放行原生模块构建脚本。
  const deployPkgPath = join(deployDir, 'package.json')
  writeFileSync(deployPkgPath, JSON.stringify({
    name: 'dsh-runtime',
    private: true,
    version: '0.0.0',
    dependencies: { '@deepseek-ai/dsh': `^${info.version}` },
    allowScripts: {
      'node-pty': true,
      koffi: true,
      '@deepseek-ai/dsh-subprocess-local': true,
      '@google/genai': false,
      protobufjs: false,
    },
  }, null, 2))

  diag(`npm install @deepseek-ai/dsh@${info.version} in ${deployDir}`)
  // 全新安装：删除复制的旧 node_modules，避免 npm 对旧树做缓慢的增量 reify。
  // 用户机器上 npm 有本地缓存，后续更新会显著加快。
  rmRuntimeDir(join(deployDir, 'node_modules'))
  rmRuntimeDir(join(deployDir, 'package-lock.json'))
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      nodeExe,
      [npmCli, 'install', '--no-audit', '--no-fund'],
      { cwd: deployDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    let stderrText = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderrText += chunk.toString() })
    child.on('error', (error) => reject(new Error(`npm install 启动失败：${error.message}`)))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm install 失败（exit ${code ?? 'null'}）：${stderrText.slice(-800)}`))
    })
  })

  // 校验安装结果：dsh bin 存在且版本一致。
  const bin = join(deployDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const manifest = join(deployDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!existsSync(bin)) {
    rmRuntimeDir(tmp)
    throw new Error('npm install 后缺少 dsh bin')
  }
  let installedVersion: string | undefined
  try {
    installedVersion = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version as string | undefined
  } catch {
    /* 版本读取失败走下面的不符分支 */
  }
  if (installedVersion !== info.version) {
    rmRuntimeDir(tmp)
    throw new Error(`引擎版本不符：期望 ${info.version}，实际 ${installedVersion ?? '未知'}`)
  }

  rmRuntimeDir(target)
  renameSync(tmp, target)
  writeRuntimeState({ version: info.version, dir: target, appliedAt: new Date().toISOString() })
  diag(`runtime installed at ${target} (npm direct)`)
  return null
}

/** 更新引擎：按 kind 分流（npm 直装 / zip 下载解压）。返回“恢复”函数。 */
async function downloadAndInstallRuntime(info: RuntimeUpdateInfo): Promise<(() => Promise<void>) | null> {
  if (info.kind === 'npm') {
    return installRuntimeFromNpm(info)
  }
  const userData = app.getPath('userData')
  const zipDir = join(userData, 'updates')
  mkdirSync(zipDir, { recursive: true })
  const zipPath = join(zipDir, `dsh-runtime-v${info.version}.zip`)
  diag(`runtime download start ${info.url}`)
  const res = await fetch(info.url)
  if (!res.ok || res.body === null) {
    if (res.status === 404) {
      throw new Error(`官方引擎 v${info.version} 的更新包尚未构建完成（自动构建进行中），请稍后重试`)
    }
    throw new Error(`下载引擎更新失败（${res.status}）`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (info.sha256 === '') {
    // 尝试拉取 <zip>.sha256 校验文件（自动构建 Action 发布）；取不到则跳过校验。
    try {
      const sumRes = await fetch(`${info.url}.sha256`)
      if (sumRes.ok) info.sha256 = (await sumRes.text()).trim().toLowerCase()
    } catch {
      /* 无校验文件 */
    }
  }
  if (info.sha256 !== '') {
    const hash = createHash('sha256').update(buffer).digest('hex')
    if (hash !== info.sha256) throw new Error(`引擎更新包校验失败（sha256 不匹配，期望 ${info.sha256}，实际 ${hash}）`)
  }
  writeFileSync(zipPath, buffer)
  diag(`runtime downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`)

  // 替换前先停掉当前实例的 dsh 服务器，释放目标目录被占用的文件句柄。
  let restore: (() => Promise<void>) | null = null
  if (preInstallHook !== null) {
    diag('stopping dsh server before runtime swap')
    restore = await preInstallHook()
  }

  const target = join(userData, `runtime-v${info.version}`)
  const tmp = `${target}.tmp`
  rmRuntimeDir(tmp)
  mkdirSync(tmp, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    // Windows 自带 bsdtar，可直接解压 zip。
    execFile('tar', ['-xf', zipPath, '-C', tmp], (error) => {
      if (error === null) resolve()
      else reject(new Error(`解压失败：${String(error)}`))
    })
  })
  if (!existsSync(join(tmp, 'node', 'node.exe'))
    || !existsSync(join(tmp, 'dsh-deploy', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    rmRuntimeDir(tmp)
    throw new Error('引擎更新包内容不完整（缺少 node.exe 或 dsh bin）')
  }
  rmRuntimeDir(target)
  renameSync(tmp, target)
  writeRuntimeState({ version: info.version, dir: target, appliedAt: new Date().toISOString() })
  diag(`runtime installed at ${target}`)
  return restore
}

/**
 * 检查 dsh 引擎更新。
 * @param manual - 是否由用户手动触发（决定“已是最新 / 失败”是否弹窗）。
 */
export async function checkRuntimeUpdates(manual: boolean): Promise<void> {
  diag(`checkRuntimeUpdates manual=${manual} start`)
  if (!app.isPackaged) {
    diag('runtime check skipped: dev mode')
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        title: t('eng.checkTitle'),
        message: t('eng.devMode'),
        detail: t('eng.devModeDetail'),
      })
    }
    return
  }
  const current = readRuntimeState()?.version ?? currentDshVersion() ?? '0.0.0'
  if (current === undefined) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'error',
        title: t('eng.checkTitle'),
        message: t('eng.readVersionFailed'),
      })
    }
    return
  }
  manualCheckPending = manual
  let info: RuntimeUpdateInfo | null = null
  try {
    info = await fetchRuntimeUpdateInfo()
  } catch (error) {
    diag(`runtime check failed: ${String(error)}`)
    if (manual) {
      manualCheckPending = false
      await dialog.showMessageBox({
        type: 'error',
        title: t('eng.checkFailedTitle'),
        message: t('eng.checkFailed'),
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }
  manualCheckPending = false
  if (info === null) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        title: t('eng.checkTitle'),
        message: t('eng.noPackage'),
        detail: t('eng.noPackageDetail'),
      })
    }
    return
  }  if (!isNewerVersion(info.version, current)) {
    diag(`runtime up to date (${current})`)
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        title: t('eng.checkTitle'),
        message: t('eng.latest'),
        detail: t('eng.latestDetail', { version: current }),
      })
    }
    return
  }
  diag(`runtime update available: ${current} -> ${info.version}`)
  if (updating) return
  updating = true
  let locked = false
  try {
    // 确认要更新后再取跨进程锁：下载/解压/替换全程持锁，其它实例的检查会跳过。
    if (!acquireUpdateLock()) {
      diag('runtime update skipped: another update in progress (lock held)')
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: t('eng.checkTitle'),
          message: t('eng.inProgress'),
        })
      }
      return
    }
    locked = true
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: t('eng.newTitle'),
      message: t('eng.newMessage', { version: info.version }),
      detail: t('eng.newDetail', { current, version: info.version }),
      buttons: [t('upd.now'), t('upd.later')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (response !== 0) {
      diag('runtime update postponed')
      return
    }
    let restore: (() => Promise<void>) | null = null
    try {
      restore = await downloadAndInstallRuntime(info)
      diag(`runtime updated: v${current} -> v${info.version}`)
      const { response: restartResponse } = await dialog.showMessageBox({
        type: 'info',
        title: t('eng.readyTitle'),
        message: t('eng.readyMessage'),
        detail: t('eng.readyDetail'),
        buttons: [t('upd.restart'), t('upd.later')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (restartResponse === 0) {
        // 重启后 runtime.ts 优先读 userData 中的新引擎。
        // 引擎更新不涉及 electron-updater 的安装器流程，用 relaunch + exit 立即
        // 重启最可靠（app.quit() 的自然退出可能被残留的模态对话框阻塞）。
        app.relaunch()
        app.exit(0)
      } else {
        // 不重启：用恢复函数拉起服务器（此时已使用新引擎），无需退出。
        if (restore !== null) await restore()
      }
    } catch (error) {
      diag(`runtime update failed: ${String(error)}`)
      // 替换失败时恢复服务器，避免应用处于“无服务器”状态。
      if (restore !== null) await restore().catch(() => undefined)
      await dialog.showMessageBox({
        type: 'error',
        title: t('eng.failedTitle'),
        message: t('eng.failed'),
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  } finally {
    if (locked) releaseUpdateLock()
    updating = false
  }
}

/** 注册定时检查。在 app ready 后调用一次。 */
export function initRuntimeUpdater(): void {
  setTimeout(() => void checkRuntimeUpdates(false), FIRST_CHECK_DELAY_MS)
  setInterval(() => void checkRuntimeUpdates(false), AUTO_CHECK_INTERVAL_MS)
}

/**
 * 恢复为随壳发布的内置引擎：删除用户更新的引擎状态，停服务器后用内置引擎
 * 重新拉起（无需重启应用）。用户更新引擎后想回到“与壳最适配”的版本时使用。
 */
export async function restoreBundledRuntime(): Promise<void> {
  diag('restoreBundledRuntime start')
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      title: t('restore.title'),
      message: t('restore.devMode'),
    })
    return
  }
  const state = readRuntimeState()
  if (state === null) {
    await dialog.showMessageBox({
      type: 'info',
      title: t('restore.title'),
      message: t('restore.alreadyBundled'),
      detail: t('restore.alreadyBundledDetail', { version: bundledDshVersion() ?? t('about.unknown') }),
    })
    return
  }
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: t('restore.title'),
    message: t('restore.confirm'),
    detail: t('restore.confirmDetail', {
      current: state.version,
      builtin: bundledDshVersion() ?? t('about.unknown'),
    }),
    buttons: [t('restore.confirmBtn'), t('restore.cancelBtn')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response !== 0) return
  let restore: (() => Promise<void>) | null = null
  if (preInstallHook !== null) {
    diag('stopping dsh server before runtime restore')
    restore = await preInstallHook()
  }
  removeRuntimeState()
  const userData = app.getPath('userData')
  try {
    for (const entry of readdirSync(userData)) {
      if (entry.startsWith('runtime-v')) rmRuntimeDir(join(userData, entry))
    }
  } catch {
    /* 忽略 */
  }
  diag(`runtime restored to bundled v${bundledDshVersion() ?? 'unknown'}`)
  if (restore !== null) {
    await restore().catch((error) => diag(`server restart after restore failed: ${String(error)}`))
  }
  await dialog.showMessageBox({
    type: 'info',
    title: t('restore.doneTitle'),
    message: t('restore.done', { version: bundledDshVersion() ?? t('about.unknown') }),
    detail: t('restore.doneDetail'),
  })
}
