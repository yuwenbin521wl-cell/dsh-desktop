/**
 * 壳（桌面版外壳）i18n：语言跟随 dsh 引擎。
 * 引擎语言偏好存在 <DSH_HOME>/settings.yaml 的 `locale.preference`（zh/en；
 * 缺省时由引擎按浏览器语言决定）。壳按以下优先级解析语言：
 *   1. DSH_DESKTOP_LANG 环境变量显式覆盖；
 *   2. <DSH_HOME>/settings.yaml 的 locale.preference；
 *   3. 系统语言（LANG 以 zh 开头 → zh，否则 en）。
 * 菜单/托盘等静态界面通过轮询跟随引擎语言变化；对话框在弹出前刷新语言。
 * @module dsh-desktop/i18n
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 壳支持的语言。 */
export type ShellLang = 'zh' | 'en'

/** 词条表。 */
const MESSAGES = {
  zh: {
    // 菜单 / 托盘
    'menu.file': '文件',
    'menu.edit': '编辑',
    'menu.help': '帮助',
    'menu.quit': '退出',
    'menu.undo': '撤销',
    'menu.redo': '重做',
    'menu.cut': '剪切',
    'menu.copy': '复制',
    'menu.paste': '粘贴',
    'menu.selectAll': '全选',
    'menu.checkUpdate': '检查更新…',
    'menu.checkEngine': '检查引擎更新…',
    'menu.restoreEngine': '恢复内置引擎…',
    'menu.about': '关于 DeepSeek Harness',
    'tray.show': '显示主窗口',
    'tray.quit': '退出',
    // 关于
    'about.title': '关于',
    'about.message': 'DeepSeek Harness 桌面版',
    'about.version': '版本：v{version}',
    'about.engine': 'dsh 引擎：v{version}（内置 {builtin}）',
    'about.devMode': '开发模式（仓库构建）',
    'about.unknown': '未知',
    // 壳更新
    'upd.newTitle': '发现新版本',
    'upd.newMessage': '发现新版本 v{version}',
    'upd.newDetail': '当前版本 v{version}\n是否立即下载并更新？更新完成后需要重启应用。',
    'upd.now': '立即更新',
    'upd.later': '稍后',
    'upd.downloadFailedTitle': '下载更新失败',
    'upd.downloadFailed': '更新下载失败，请稍后重试。',
    'upd.readyTitle': '更新已就绪',
    'upd.readyMessage': '新版本已下载完成。',
    'upd.readyDetail': '重启应用即可完成安装。是否立即重启？',
    'upd.restart': '立即重启',
    'upd.restartFailedTitle': '无法自动重启',
    'upd.restartFailed': '未能自动重启安装更新。',
    'upd.restartFailedDetail': '此环境（未安装 / 开发模式）不支持自动安装，请使用安装版体验完整更新流程。',
    'upd.checkTitle': '检查更新',
    'upd.latest': '当前已是最新版本。',
    'upd.latestDetail': 'DeepSeek Harness 桌面版 v{version}',
    'upd.devMode': '当前为开发模式，自动更新不可用。',
    'upd.devModeDetail': '请使用打包安装版（npm run dist）体验自动更新。',
    'upd.failedTitle': '检查更新失败',
    'upd.failed': '无法检查更新。',
    // 引擎更新
    'eng.checkTitle': '检查引擎更新',
    'eng.devMode': '当前为开发模式，引擎更新不可用。',
    'eng.devModeDetail': '请使用打包安装版（npm run dist）体验引擎更新。',
    'eng.readVersionFailed': '无法读取当前引擎版本。',
    'eng.checkFailedTitle': '检查引擎更新失败',
    'eng.checkFailed': '无法检查引擎更新。',
    'eng.noPackage': '没有找到引擎更新包。',
    'eng.noPackageDetail': '官方刚发布新版时，更新包可能正在自动构建（engine-sync），请稍后重试；或确认已在 GitHub Releases 发布 dsh-runtime-vX.zip。',
    'eng.latest': '当前引擎已是最新版本。',
    'eng.latestDetail': 'dsh 引擎 v{version}',
    'eng.newTitle': '发现新的 dsh 引擎',
    'eng.newMessage': '检测到新的 dsh 引擎 v{version}',
    'eng.newDetail': '当前引擎 v{current}\n是否下载并更新？更新完成后需要重启应用生效。',
    'eng.inProgress': '已有引擎更新正在进行，请稍后再试。',
    'eng.readyTitle': '引擎更新已就绪',
    'eng.readyMessage': 'dsh 引擎更新已完成。',
    'eng.readyDetail': '重启应用后使用新引擎。是否立即重启？',
    'eng.failedTitle': '引擎更新失败',
    'eng.failed': '引擎更新失败。',
    // 恢复内置引擎
    'restore.title': '恢复内置引擎',
    'restore.devMode': '当前为开发模式，无内置引擎概念。',
    'restore.alreadyBundled': '当前已在用随壳发布的内置引擎。',
    'restore.alreadyBundledDetail': '内置引擎 v{version}',
    'restore.confirm': '恢复为随壳发布的引擎版本？',
    'restore.confirmDetail': '当前引擎 v{current}（用户更新）\n内置引擎 v{builtin}（随壳发布，与壳最适配）\n恢复后立即生效，无需重启应用。',
    'restore.confirmBtn': '恢复',
    'restore.cancelBtn': '取消',
    'restore.doneTitle': '恢复完成',
    'restore.done': '已恢复内置引擎 v{version}。',
    'restore.doneDetail': '当前服务器已使用随壳发布的引擎。',
    // 启动错误
    'start.failedTitle': '无法启动 DeepSeek Harness',
    // 启动页
    'splash.starting': '正在启动 DeepSeek Harness…',
  },
  en: {
    'menu.file': 'File',
    'menu.edit': 'Edit',
    'menu.help': 'Help',
    'menu.quit': 'Quit',
    'menu.undo': 'Undo',
    'menu.redo': 'Redo',
    'menu.cut': 'Cut',
    'menu.copy': 'Copy',
    'menu.paste': 'Paste',
    'menu.selectAll': 'Select All',
    'menu.checkUpdate': 'Check for Updates…',
    'menu.checkEngine': 'Check for Engine Updates…',
    'menu.restoreEngine': 'Restore Bundled Engine…',
    'menu.about': 'About DeepSeek Harness',
    'tray.show': 'Show Main Window',
    'tray.quit': 'Quit',
    'about.title': 'About',
    'about.message': 'DeepSeek Harness Desktop',
    'about.version': 'Version: v{version}',
    'about.engine': 'dsh engine: v{version} (bundled {builtin})',
    'about.devMode': 'dev mode (repo build)',
    'about.unknown': 'unknown',
    'upd.newTitle': 'Update Available',
    'upd.newMessage': 'New version v{version} is available',
    'upd.newDetail': 'Current version v{version}\nDownload and update now? The app will restart after updating.',
    'upd.now': 'Update Now',
    'upd.later': 'Later',
    'upd.downloadFailedTitle': 'Download Failed',
    'upd.downloadFailed': 'Failed to download the update. Please try again later.',
    'upd.readyTitle': 'Update Ready',
    'upd.readyMessage': 'The new version has been downloaded.',
    'upd.readyDetail': 'Restart the app to finish installing. Restart now?',
    'upd.restart': 'Restart Now',
    'upd.restartFailedTitle': 'Cannot Restart',
    'upd.restartFailed': 'Could not restart to install the update.',
    'upd.restartFailedDetail': 'Automatic installation is not supported in this environment (unpacked/dev). Use the installed version for the full flow.',
    'upd.checkTitle': 'Check for Updates',
    'upd.latest': 'You are up to date.',
    'upd.latestDetail': 'DeepSeek Harness Desktop v{version}',
    'upd.devMode': 'Auto-update is only available in packaged builds.',
    'upd.devModeDetail': 'Run npm run dist and install the packaged build to try auto-update.',
    'upd.failedTitle': 'Update Check Failed',
    'upd.failed': 'Could not check for updates.',
    'eng.checkTitle': 'Check for Engine Updates',
    'eng.devMode': 'Engine updates are only available in packaged builds.',
    'eng.devModeDetail': 'Run npm run dist and install the packaged build to try engine updates.',
    'eng.readVersionFailed': 'Could not read the current engine version.',
    'eng.checkFailedTitle': 'Engine Update Check Failed',
    'eng.checkFailed': 'Could not check for engine updates.',
    'eng.noPackage': 'No engine update package found.',
    'eng.noPackageDetail': 'If the official engine just released a new version, the update package may still be building (engine-sync); try again later, or confirm dsh-runtime-vX.zip is published to GitHub Releases.',
    'eng.latest': 'The engine is up to date.',
    'eng.latestDetail': 'dsh engine v{version}',
    'eng.newTitle': 'New dsh Engine Available',
    'eng.newMessage': 'A new dsh engine v{version} is available',
    'eng.newDetail': 'Current engine v{current}\nDownload and update now? The app will restart to activate it.',
    'eng.inProgress': 'An engine update is already in progress. Please try again later.',
    'eng.readyTitle': 'Engine Update Ready',
    'eng.readyMessage': 'The dsh engine update has completed.',
    'eng.readyDetail': 'Restart the app to use the new engine. Restart now?',
    'eng.failedTitle': 'Engine Update Failed',
    'eng.failed': 'The engine update failed.',
    'restore.title': 'Restore Bundled Engine',
    'restore.devMode': 'There is no bundled engine in dev mode.',
    'restore.alreadyBundled': 'You are already using the engine bundled with the shell.',
    'restore.alreadyBundledDetail': 'Bundled engine v{version}',
    'restore.confirm': 'Restore the engine bundled with this shell?',
    'restore.confirmDetail': 'Current engine v{current} (user-updated)\nBundled engine v{builtin} (shipped with the shell, best compatibility)\nTakes effect immediately, no app restart needed.',
    'restore.confirmBtn': 'Restore',
    'restore.cancelBtn': 'Cancel',
    'restore.doneTitle': 'Restore Complete',
    'restore.done': 'Restored bundled engine v{version}.',
    'restore.doneDetail': 'The server is now using the engine shipped with the shell.',
    'start.failedTitle': 'Cannot Start DeepSeek Harness',
    'splash.starting': 'Starting DeepSeek Harness…',
  },
} as const

export type ShellMessageKey = keyof typeof MESSAGES['zh']

let currentLang: ShellLang = 'zh'

/** 读取引擎语言偏好（<DSH_HOME>/settings.yaml 的 locale.preference）。 */
function enginePreference(): ShellLang | null {
  try {
    const home = process.env.DSH_HOME
    if (home === undefined || home === '') return null
    const yaml = readFileSync(join(home, 'settings.yaml'), 'utf8')
    const match = yaml.match(/^\s*preference:\s*['"]?(zh|en)['"]?\s*$/m)
    if (match !== null) return match[1] as ShellLang
  } catch {
    /* settings.yaml 不存在或不可读 */
  }
  return null
}

/** 解析当前壳语言（不缓存，供需要时调用）。 */
export function resolveShellLanguage(): ShellLang {
  const env = process.env.DSH_DESKTOP_LANG
  if (env === 'zh' || env === 'en') {
    currentLang = env
    return currentLang
  }
  const pref = enginePreference()
  if (pref !== null) {
    currentLang = pref
    return currentLang
  }
  const sys = (process.env.LANG ?? '').toLowerCase()
  currentLang = sys.startsWith('zh') ? 'zh' : 'en'
  return currentLang
}

/** 当前壳语言（须先 resolveShellLanguage 或 refreshShellLanguage）。 */
export function shellLanguage(): ShellLang {
  return currentLang
}

/** 刷新语言（启动时及轮询时调用）。返回语言是否发生变化。 */
export function refreshShellLanguage(): boolean {
  const before = currentLang
  const after = resolveShellLanguage()
  return before !== after
}

/** 按当前语言取词条，{key} 占位符用 values 替换。 */
export function t(key: ShellMessageKey, values?: Record<string, string | undefined>): string {
  resolveShellLanguage()
  let text: string = MESSAGES[currentLang][key] ?? MESSAGES.zh[key] ?? key
  if (values !== undefined) {
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, value ?? '')
    }
  }
  return text
}
