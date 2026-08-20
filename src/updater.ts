/**
 * 自更新：基于 electron-updater，默认从 GitHub Releases（electron-builder 打包时
 * 写入 app-update.yml 的源）检查新版本。发现新版本时弹出中文对话框询问“是否更新”，
 * 用户确认后下载；下载完成后再询问“是否重启安装”。
 *
 * 更新源覆盖：
 * - 环境变量 DSH_DESKTOP_UPDATE_URL：指向 generic 源（自建服务器 / 本地测试 feed），
 *   适用于无法直连 GitHub 的网络或联调场景。
 * - 开发模式（未打包）下，若 desktop/dev-app-update.yml 存在则启用
 *   forceDevUpdateConfig，用该文件配置的源测试更新流程。
 *
 * 触发时机：启动后 10 秒自动检查一次，之后每 6 小时一次；菜单“检查更新…”可手动触发，
 * 手动检查时“已是最新 / 检查失败”会给出对话框提示。
 * @module dsh-desktop/updater
 */

import { app, dialog } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { diag } from './diag'
import { t } from './i18n'

/** 自动检查间隔：6 小时。 */
const AUTO_CHECK_INTERVAL_MS = 6 * 3600 * 1000

/** 启动后首次自动检查延迟：10 秒，等窗口与服务器先就绪。 */
const FIRST_CHECK_DELAY_MS = 10 * 1000

/** 手动检查是否还在等待结果（决定 update-not-available / error 是否弹窗）。 */
let manualCheckPending = false

/** 下载流程是否已在进行，防止重复触发。 */
let downloading = false

/** 当前版本号（app 自身，来自 package.json）。 */
function currentVersion(): string {
  return app.getVersion()
}

/** 日志前缀。 */
function log(...args: unknown[]): void {
  console.log('[updater]', ...args)
}

/** 发现新版本：询问是否下载。 */
async function promptUpdateAvailable(info: UpdateInfo): Promise<void> {
  if (downloading) return
  diag(`update-available v${info.version}: showing dialog`)
  let response = 1
  try {
    ;({ response } = await dialog.showMessageBox({
      type: 'info',
      title: t('upd.newTitle'),
      message: t('upd.newMessage', { version: info.version }),
      detail: t('upd.newDetail', { version: currentVersion() }),
      buttons: [t('upd.now'), t('upd.later')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }))
    diag(`update dialog returned ${response}`)
  } catch (error) {
    diag(`update dialog threw: ${String(error)}`)
    return
  }
  if (response !== 0) {
    log('user postponed update', info.version)
    return
  }
  downloading = true
  try {
    diag('downloadUpdate start')
    await autoUpdater.downloadUpdate()
    diag('downloadUpdate done')
  } catch (error) {
    downloading = false
    diag(`downloadUpdate failed: ${String(error)}`)
    log('download failed', error)
    void dialog.showMessageBox({
      type: 'error',
      title: t('upd.downloadFailedTitle'),
      message: t('upd.downloadFailed'),
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

/** 更新已下载：询问是否立即重启安装。 */
async function promptQuitAndInstall(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: t('upd.readyTitle'),
    message: t('upd.readyMessage'),
    detail: t('upd.readyDetail'),
    buttons: [t('upd.restart'), t('upd.later')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response !== 0) {
    log('user postponed restart; update installs on next quit')
    return
  }
  try {
    // isSilent=true + isForceRunAfter=true：安装器完成安装后自动启动新版应用
    // （isForceRunAfter=false 时 electron-updater 不会传 --force-run，安装完不启动）。
    autoUpdater.quitAndInstall(true, true)
  } catch (error) {
    // 未安装的 unpacked / 开发环境没有安装器可执行，quitAndInstall 会失败。
    log('quitAndInstall failed:', error)
    void dialog.showMessageBox({
      type: 'error',
      title: t('upd.restartFailedTitle'),
      message: t('upd.restartFailed'),
      detail: t('upd.restartFailedDetail'),
    })
  }
}

/**
 * 注册自动更新事件与定时检查。在 app ready 后调用一次。
 */
export function initUpdater(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  if (process.env.DSH_DESKTOP_UPDATE_URL !== undefined && process.env.DSH_DESKTOP_UPDATE_URL !== '') {
    log('using generic update feed from DSH_DESKTOP_UPDATE_URL:', process.env.DSH_DESKTOP_UPDATE_URL)
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.DSH_DESKTOP_UPDATE_URL })
  } else if (!app.isPackaged && existsSync(join(app.getAppPath(), 'dev-app-update.yml'))) {
    log('dev mode: forceDevUpdateConfig enabled (dev-app-update.yml present)')
    autoUpdater.forceDevUpdateConfig = true
  }

  autoUpdater.on('update-available', (info) => {
    manualCheckPending = false
    diag(`event update-available v${info.version}`)
    log('update available:', info.version)
    void promptUpdateAvailable(info)
  })
  autoUpdater.on('update-not-available', (info) => {
    log('update not available:', info.version)
    if (manualCheckPending) {
      manualCheckPending = false
      void dialog.showMessageBox({
        type: 'info',
        title: t('upd.checkTitle'),
        message: t('upd.latest'),
        detail: t('upd.latestDetail', { version: currentVersion() }),
      })
    }
  })
  autoUpdater.on('update-downloaded', (info) => {
    diag(`event update-downloaded v${info.version}`)
    log('update downloaded:', info.version)
    void promptQuitAndInstall()
  })
  autoUpdater.on('error', (error) => {
    diag(`event updater error: ${String(error)}`)
    log('updater error:', error)
    if (manualCheckPending) {
      manualCheckPending = false
      void dialog.showMessageBox({
        type: 'error',
        title: t('upd.failedTitle'),
        message: t('upd.failed'),
        detail: error.message,
      })
    }
  })

  setTimeout(() => void checkForUpdates(false), FIRST_CHECK_DELAY_MS)
  setInterval(() => void checkForUpdates(false), AUTO_CHECK_INTERVAL_MS)
}

/**
 * 检查更新。
 * @param manual - 是否由用户手动触发（决定“已是最新 / 失败”是否弹窗）。
 */
export async function checkForUpdates(manual: boolean): Promise<void> {
  diag(`checkForUpdates manual=${manual} start`)
  if (!app.isPackaged && autoUpdater.forceDevUpdateConfig !== true) {
    diag('checkForUpdates skipped: dev mode')
    log('auto-update is only available in packaged builds; skipping check')
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        title: t('upd.checkTitle'),
        message: t('upd.devMode'),
        detail: t('upd.devModeDetail'),
      })
    }
    return
  }
  manualCheckPending = manual
  try {
    await autoUpdater.checkForUpdates()
    diag('checkForUpdates done')
  } catch (error) {
    diag(`checkForUpdates threw: ${String(error)}`)
    log('checkForUpdates threw:', error)
    if (manual) {
      manualCheckPending = false
      await dialog.showMessageBox({
        type: 'error',
        title: t('upd.failedTitle'),
        message: t('upd.failed'),
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
