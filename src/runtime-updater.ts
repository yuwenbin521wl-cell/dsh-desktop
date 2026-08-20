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
import { execFile } from 'node:child_process'
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { currentDshVersion, readRuntimeState, rmRuntimeDir, writeRuntimeState, bundledDshVersion, removeRuntimeState } from './runtime'
import { hideEngineProgress, setTaskbarProgress, showEngineProgress, updateEngineProgress } from './engine-progress'
import { diag } from './diag'
import { t } from './i18n'

/** 引擎 zip 发布的 GitHub 仓库（owner/repo），可用 DSH_DESKTOP_RUNTIME_REPO 覆盖。 */
const RUNTIME_RELEASE_REPO = 'yuwenbin521wl-cell/dsh-desktop'

/** 自动检查间隔：6 小时。 */
const AUTO_CHECK_INTERVAL_MS = 6 * 3600 * 1000

/** 启动后首次自动检查延迟：12 秒。 */
const FIRST_CHECK_DELAY_MS = 12 * 1000

/** 引擎更新信息。 */
interface RuntimeUpdateInfo {
  version: string
  /** zip 下载地址。 */
  url: string
  /** 小写 hex sha256；为空则跳过校验。 */
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

/** 检查阶段请求超时：45 秒（用户网络到 api.github.com 可能很慢）。 */
const CHECK_TIMEOUT_MS = 45 * 1000

/** 带超时的 fetch：超时/网络错误统一转为带中文说明的 Error（进度窗口会立刻显示失败原因）。 */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error('检查超时（45 秒），请检查网络后重试')
    }
    throw error
  }
}

/**
 * 解析最新引擎信息：
 * 1. 自建源（DSH_DESKTOP_RUNTIME_URL → latest.json，含 version/url/sha256）优先；
 * 2. 默认：查发布仓库（默认 yuwenbin521wl-cell/dsh-desktop）Releases 里最新的
 *    dsh-engine-v* release，取其 dsh-runtime-v<version>.zip 资产（由 engine-sync
 *    自动从官方代码构建发布）。zip 存在才视为“可更新”——版本与官方代码同步，
 *    构建完成才能检测到，天然避免“提示可更新但点下去 404”。
 *    国内网络可设置 DSH_DESKTOP_GITHUB_PROXY（如 https://ghproxy.com/）加速下载。
 */
async function fetchRuntimeUpdateInfo(): Promise<RuntimeUpdateInfo | null> {
  const custom = process.env.DSH_DESKTOP_RUNTIME_URL
  if (custom !== undefined && custom !== '') {
    diag(`runtime feed: custom ${custom}`)
    const res = await fetchWithTimeout(`${custom}/latest.json`, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`引擎更新源返回 ${res.status}`)
    const data = await res.json() as { version?: unknown; url?: unknown; sha256?: unknown }
    if (typeof data.version !== 'string' || typeof data.url !== 'string') {
      throw new Error('引擎更新源格式错误（latest.json 需要 version/url 字段）')
    }
    const url = /^https?:\/\//.test(data.url) ? data.url : `${custom}/${data.url.replace(/^\//, '')}`
    return {
      version: data.version,
      url,
      sha256: typeof data.sha256 === 'string' ? data.sha256.toLowerCase() : '',
    }
  }
  const repo = (process.env.DSH_DESKTOP_RUNTIME_REPO ?? RUNTIME_RELEASE_REPO).replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '')
  diag(`runtime feed: releases of ${repo} (dsh-engine-v*)`)
  const res = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases?per_page=50`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop' },
  })
  if (!res.ok) throw new Error(`GitHub Releases 查询失败（${res.status}）。请检查网络或 DSH_DESKTOP_RUNTIME_REPO 配置`)
  const releases = await res.json() as Array<{
    tag_name?: string
    assets?: Array<{ name?: string; browser_download_url?: string; digest?: string }>
  }>
  for (const release of releases) {
    if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith('dsh-engine-v')) continue
    const asset = (release.assets ?? []).find((a) => typeof a.name === 'string' && /^dsh-runtime-v.*\.zip$/i.test(a.name))
    if (asset?.name === undefined || asset.browser_download_url === undefined) continue
    const version = asset.name.replace(/^dsh-runtime-v/i, '').replace(/\.zip$/i, '')
    const rawUrl = asset.browser_download_url
    const proxy = process.env.DSH_DESKTOP_GITHUB_PROXY
    const url = proxy !== undefined && proxy !== '' ? `${proxy.replace(/\/$/, '')}/${rawUrl}` : rawUrl
    const digest = asset.digest ?? ''
    diag(`engine release found: ${release.tag_name} (${url})`)
    return { version, url, sha256: digest.replace(/^sha256:/i, '').toLowerCase() }
  }
  diag('no dsh-engine-v* release with runtime zip found')
  return null
}

/** 下载超时：15 分钟（约 100MB，国内网络可能很慢）。 */
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 更新引擎（流式下载 zip → sha256 校验 → bsdtar 解压）。全程通过进度窗口
 * 显示阶段与下载百分比；替换前停掉 dsh 服务器以释放文件句柄。
 * @returns “恢复”函数：替换完成后若用户选择不重启，用它拉起服务器（新引擎）。
 */
async function downloadAndInstallRuntime(info: RuntimeUpdateInfo): Promise<(() => Promise<void>) | null> {
  const userData = app.getPath('userData')
  const zipDir = join(userData, 'updates')
  mkdirSync(zipDir, { recursive: true })
  const zipPath = join(zipDir, `dsh-runtime-v${info.version}.zip`)
  diag(`runtime download start ${info.url}`)

  showEngineProgress()
  let sha256 = info.sha256
  if (sha256 === '') {
    // 尝试拉取 <zip>.sha256 校验文件（自动构建 Action 发布）；取不到则跳过校验。
    try {
      const sumRes = await fetch(`${info.url}.sha256`, { signal: AbortSignal.timeout(15000) })
      if (sumRes.ok) sha256 = (await sumRes.text()).trim().toLowerCase()
    } catch {
      /* 无校验文件 */
    }
  }
  updateEngineProgress(t('prog.downloading', { version: info.version, pct: '0', mb: '0', totalMb: '?' }), 0)
  setTaskbarProgress(0)
  let res: Response
  try {
    res = await fetch(info.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error('下载超时（15 分钟），请检查网络后重试')
    }
    throw error
  }
  if (!res.ok || res.body === null) {
    if (res.status === 404) {
      throw new Error(`官方引擎 v${info.version} 的更新包尚未构建完成（自动构建进行中），请稍后重试`)
    }
    throw new Error(`下载引擎更新失败（${res.status}）`)
  }
  const total = Number(res.headers.get('content-length')) || 0
  const hash = sha256 !== '' ? createHash('sha256') : null
  rmSync(zipPath, { force: true })
  const file = createWriteStream(zipPath)
  // 用对象包装错误状态：TS 闭包分析会把“只在回调里赋值”的 let 变量推断为初始
  // 类型（null），导致收窄后变成 never；对象属性不受此限制。
  const fileState: { error: Error | null } = { error: null }
  file.on('error', (error: Error) => {
    fileState.error = error
  })
  const reader = res.body.getReader()
  let received = 0
  let lastReport = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (hash !== null) hash.update(value)
      if (!file.write(value)) await new Promise<void>((resolve) => file.once('drain', resolve))
      if (fileState.error !== null) throw new Error(`写入更新包失败：${fileState.error.message}`)
      // 进度 UI 节流：每 100ms 刷新一次窗口/任务栏。
      const now = Date.now()
      if (now - lastReport >= 100) {
        lastReport = now
        if (total > 0) {
          const pct = received / total
          updateEngineProgress(
            t('prog.downloading', {
              version: info.version,
              pct: String(Math.round(pct * 100)),
              mb: (received / 1048576).toFixed(1),
              totalMb: (total / 1048576).toFixed(1),
            }),
            pct * 100,
          )
          setTaskbarProgress(Math.min(pct, 0.99))
        } else {
          updateEngineProgress(t('prog.downloadingSize', { version: info.version, mb: (received / 1048576).toFixed(1) }), null)
          setTaskbarProgress(0, true)
        }
      }
    }
  } finally {
    reader.releaseLock()
    await new Promise<void>((resolve, reject) => {
      file.end((error?: Error | null) => (error === undefined || error === null ? resolve() : reject(error)))
    })
  }
  if (hash !== null) {
    updateEngineProgress(t('prog.verifying'), null)
    setTaskbarProgress(0, true)
    const digest = hash.digest('hex')
    if (digest !== sha256) {
      rmSync(zipPath, { force: true })
      throw new Error(`引擎更新包校验失败（sha256 不匹配，期望 ${sha256}，实际 ${digest}）`)
    }
  }
  diag(`runtime downloaded ${(received / 1048576).toFixed(1)} MB`)

  // 替换前先停掉当前实例的 dsh 服务器，释放目标目录被占用的文件句柄。
  let restore: (() => Promise<void>) | null = null
  if (preInstallHook !== null) {
    diag('stopping dsh server before runtime swap')
    updateEngineProgress(t('prog.installing', { version: info.version }), null)
    setTaskbarProgress(0, true)
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
  // 手动检查：点击后立即给反馈（检查请求可能耗时数十秒，避免看起来“没反应”）。
  if (manual) {
    showEngineProgress()
    updateEngineProgress(t('prog.checking'), null)
    setTaskbarProgress(0, true)
  }
  let info: RuntimeUpdateInfo | null = null
  try {
    info = await fetchRuntimeUpdateInfo()
  } catch (error) {
    diag(`runtime check failed: ${String(error)}`)
    if (manual) {
      hideEngineProgress()
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
  if (manual) hideEngineProgress()
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
      hideEngineProgress()
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
      hideEngineProgress()
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
