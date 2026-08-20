/**
 * DeepSeek Harness 桌面版主进程：单实例锁、拉起 dsh web 服务器、在桌面窗口内
 * 加载 Web UI、注册菜单（检查更新 / 关于 / 退出）、系统托盘（关闭窗口时最小化
 * 到托盘而非退出）、退出时回收服务器进程树。
 * @module dsh-desktop/main
 */

import { app, BrowserWindow, dialog, Menu, nativeImage, session, shell, Tray } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { diag, initDiag, installDiagHandlers } from './diag'
import { resolveDshBin, resolveNodeExecutable, bundledDshVersion, currentDshVersion } from './runtime'
import { startDshServer, type DshServerHandle } from './server'
import { checkForUpdates, initUpdater } from './updater'
import { checkRuntimeUpdates, initRuntimeUpdater, restoreBundledRuntime, setRuntimePreInstallHook } from './runtime-updater'
import { refreshShellLanguage, t } from './i18n'

/** 服务器句柄，退出时回收。 */
let server: DshServerHandle | null = null

/** 主窗口。 */
let mainWindow: BrowserWindow | null = null

/** 系统托盘实例（关闭窗口后应用继续驻留托盘）。 */
let tray: Tray | null = null

/** 是否已进入退出流程（before-quit 只拦截一次，close 事件据此放行）。 */
let shuttingDown = false

/** 应用图标路径（开发版/打包版，见 appIconPath）。 */
const APP_USER_MODEL_ID = 'com.deepseek-ai.dsh-desktop'

/** 启动等待页：服务器就绪前显示的简单 loading（语言跟随引擎）。 */
function splashHtml(): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif;font-size:15px">
${t('splash.starting')}</body></html>`
}

/** 显示（或重建）主窗口。 */
function showMainWindow(): void {
  if (mainWindow === null) {
    if (server !== null) createWindow(server.url)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * 应用图标路径：打包版在 resources/icon.png（extraResources，electron-builder 会
 * 自动排除 build/ 构建资源目录，所以不能走 asar）；开发版在 build/icon.png。
 */
function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
}

/** 兜底图标：nativeImage 加载失败时的 1x1 透明 PNG，避免 Tray 构造抛异常。 */
const FALLBACK_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** 创建系统托盘：关闭窗口不退出，驻留托盘；右键菜单可显示/检查更新/退出。 */
/** 托盘右键菜单（语言跟随引擎，可重建）。 */
function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: t('tray.show'), click: showMainWindow },
    { label: t('menu.checkUpdate'), click: () => void checkForUpdates(true) },
    { label: t('menu.checkEngine'), click: () => void checkRuntimeUpdates(true) },
    { label: t('menu.restoreEngine'), click: () => void restoreBundledRuntime() },
    { type: 'separator' },
    {
      label: t('tray.quit'),
      click: () => {
        shuttingDown = true
        app.quit()
      },
    },
  ])
}

function createTray(): void {
  if (tray !== null) return
  try {
    let image = nativeImage.createFromPath(appIconPath())
    if (image.isEmpty()) image = nativeImage.createFromDataURL(FALLBACK_ICON)
    tray = new Tray(image)
    tray.setToolTip('DeepSeek Harness')
    tray.setContextMenu(buildTrayMenu())
    tray.on('click', showMainWindow)
  } catch (error) {
    // 托盘失败不应让应用崩溃（关闭窗口走默认退出路径即可）。
    console.error('[main] tray creation failed:', error)
  }
}

/** 创建主窗口（先显示 loading，服务器就绪后加载真实 URL）。 */
function createWindow(url: string): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'DeepSeek Harness',
    icon: appIconPath(),
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  // 关闭窗口 → 最小化到系统托盘（真正退出走托盘“退出”或菜单“退出”）。
  window.on('close', (event) => {
    if (shuttingDown) return
    event.preventDefault()
    window.hide()
    if (tray === null) createTray()
  })
  // 只允许在服务器自身 origin 内导航。
  window.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) event.preventDefault()
  })
  // 外链一律交给系统浏览器，不在窗口内开新标签。
  // （启动时弹浏览器标签的根因是 dsh web 的 --open，已在 server.ts 用 --no-open
  // 关闭；此处仅保留外部链接放行 + 日志，便于将来诊断。）
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) {
      diag(`window.open -> external browser: ${target}`)
      void shell.openExternal(target)
    } else {
      diag(`window.open suppressed: ${target}`)
    }
    return { action: 'deny' }
  })
  void window.loadURL(splashHtml())
  void window.loadURL(url)
}

/** 权限处理：只放行 UI 需要的能力。 */
function installPermissionHandler(): void {
  const allowed = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen'])
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowed.has(permission))
  })
}

/** 应用菜单：文件 / 编辑（剪贴板快捷键）/ 帮助。语言跟随引擎，可重建。 */
function buildMenu(): Electron.Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: t('menu.file'),
      submenu: [{ role: 'quit', label: t('menu.quit') }],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        {
          label: t('menu.checkUpdate'),
          click: () => void checkForUpdates(true),
        },
        {
          label: t('menu.checkEngine'),
          click: () => void checkRuntimeUpdates(true),
        },
        {
          label: t('menu.restoreEngine'),
          click: () => void restoreBundledRuntime(),
        },
        { type: 'separator' },
        {
          label: t('menu.about'),
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: t('about.title'),
              message: t('about.message'),
              detail: [
                t('about.version', { version: app.getVersion() }),
                t('about.engine', {
                  version: currentDshVersion() ?? t('about.unknown'),
                  builtin: bundledDshVersion() ?? t('about.devMode'),
                }),
                `Electron：${process.versions.electron ?? t('about.unknown')}`,
                `Chromium：${process.versions.chrome ?? t('about.unknown')}`,
                `Node：${process.versions.node ?? t('about.unknown')}`,
              ].join('\n'),
            })
          },
        },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

/** 安装（或语言变化后重建）应用菜单。 */
function installMenu(): void {
  Menu.setApplicationMenu(buildMenu())
}

/** 语言轮询：引擎在引擎内切换语言后，壳的菜单/托盘跟随（每 20 秒检查一次）。 */
function installLanguageSync(): void {
  setInterval(() => {
    if (refreshShellLanguage()) {
      diag('shell language changed, rebuilding menus')
      installMenu()
      if (tray !== null) tray.setContextMenu(buildTrayMenu())
    }
  }, 20 * 1000)
}

/** 单实例：第二个实例到来时聚焦已有窗口（若已驻留托盘则先显示）。 */
function installSingleInstance(): void {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

/** 退出前回收 dsh 服务器进程树（只拦截一次；真正退出时 close 事件据此放行）。 */
function installQuitCleanup(): void {
  app.on('before-quit', (event) => {
    diag('before-quit fired')
    if (shuttingDown) return
    event.preventDefault()
    shuttingDown = true
    void (async () => {
      if (server !== null) {
        try {
          diag('stopping dsh server')
          await server.stop()
        } catch (error) {
          diag(`server stop failed: ${String(error)}`)
          console.error('[main] server stop failed:', error)
        }
        server = null
      }
      // 用 app.quit() 自然退出而非 app.exit(0)：app.exit() 会立即强杀进程，
      // 可能打断 electron-updater 的退出序列（它依赖正常的 before-quit →
      // 安装器 → 退出流程）。第二次 before-quit 不再拦截，自然放行。
      diag('app.quit() (natural exit)')
      app.quit()
    })()
  })
  app.on('will-quit', () => diag('will-quit fired'))
  app.on('quit', () => diag('quit fired'))
}

/** 启动流程：拉起服务器 → 建窗口 → 注册更新。 */
async function boot(): Promise<void> {
  diag('boot start')
  app.setAppUserModelId(APP_USER_MODEL_ID)
  // 桌面版的数据目录（DSH_HOME）始终独立：**不继承外部 DSH_HOME**——外部环境
  // 变量往往指向 web 版使用的 ~/.dsh，两个 dsh 实例并发写同一份会话文件会
  // 导致日志 seq 跳号损坏（“corrupt session log: seq gap”）。
  // 可用桌面版专属的 DSH_DESKTOP_HOME 显式覆盖（例如指向 web 版目录以刻意共享）。
  const customHome = process.env.DSH_DESKTOP_HOME
  const isolatedHome = customHome !== undefined && customHome !== ''
    ? customHome
    : join(app.getPath('userData'), 'home')
  mkdirSync(isolatedHome, { recursive: true })
  process.env.DSH_HOME = isolatedHome
  diag(`DSH_HOME (desktop, isolated): ${isolatedHome}`)
  installPermissionHandler()
  installMenu()
  installLanguageSync()
  installSingleInstance()
  installQuitCleanup()
  // 引擎更新替换运行时前：先停掉服务器释放文件句柄；替换后若用户选择不重启，
  // 用恢复函数拉起服务器（此时已使用新引擎，无需退出应用）。
  setRuntimePreInstallHook(async () => {
    const current = server
    server = null
    if (current !== null) {
      try {
        await current.stop()
      } catch (error) {
        diag(`server stop before runtime swap failed: ${String(error)}`)
      }
    }
    return async () => {
      try {
        const nodeExe = resolveNodeExecutable()
        const dshBin = resolveDshBin()
        const restarted = await startDshServer(nodeExe, dshBin)
        server = restarted
        diag(`dsh web restarted at ${restarted.url}`)
        if (mainWindow !== null && !mainWindow.isDestroyed()) void mainWindow.loadURL(restarted.url)
      } catch (error) {
        diag(`server restart failed: ${String(error)}`)
      }
    }
  })
  initUpdater()
  initRuntimeUpdater()

  try {
    const nodeExe = resolveNodeExecutable()
    const dshBin = resolveDshBin()
    diag(`starting dsh web with ${nodeExe} ${dshBin}`)
    console.log('[main] starting dsh web with', nodeExe, dshBin)
    server = await startDshServer(nodeExe, dshBin)
    diag(`dsh web ready at ${server.url}`)
    console.log('[main] dsh web ready at', server.url)
  } catch (error) {
    diag(`failed to start dsh web: ${String(error)}`)
    console.error('[main] failed to start dsh web:', error)
    dialog.showErrorBox(
      t('start.failedTitle'),
      error instanceof Error ? error.message : String(error),
    )
    app.exit(1)
    return
  }

  diag('createWindow')
  createWindow(server.url)
  // 托盘常驻：关闭窗口后应用仍在托盘运行，无需窗口也能接收“检查更新”等操作。
  diag('createTray')
  createTray()
  diag('boot done')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && server !== null) createWindow(server.url)
  })
}

// 单实例锁：拿不到说明已有实例在运行，直接退出。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(() => {
    initDiag(join(app.getPath('userData'), 'main-debug.log'))
    installDiagHandlers()
    void boot()
  })
}

// 关闭窗口是“最小化到托盘”而不是退出，因此窗口全部关闭时保持应用驻留。
app.on('window-all-closed', () => {
  /* 驻留托盘：不退出 */
})
