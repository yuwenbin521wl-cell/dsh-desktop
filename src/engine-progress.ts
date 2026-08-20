/**
 * 引擎更新进度 UI：非模态小窗口（检查中 / 下载 x% / 校验 / 解压安装）+ 主窗口
 * 任务栏进度条（Windows setProgressBar）。
 *
 * 目的：点击“检查引擎更新”后立即给出可见反馈——检查请求可能耗时数十秒、
 * 更新包约 100MB 下载更久，没有进度反馈时用户会以为“点完没反应”。
 *
 * 关闭行为：用户点击进度窗口的关闭按钮 = 取消本次更新（触发 showEngineProgress
 * 传入的 onClose 回调，由调用方 abort 下载）；程序主动 hideEngineProgress() 关闭
 * 窗口不会触发取消。
 * @module dsh-desktop/engine-progress
 */

import { BrowserWindow } from 'electron'
import { t } from './i18n'

/** 进度窗口实例（单例）。 */
let progressWin: BrowserWindow | null = null

/** 用户关闭窗口时的取消回调（仅由用户关闭触发，程序主动隐藏不触发）。 */
let closeHandler: (() => void) | null = null

/** 进度窗口 HTML（深色主题，与 splash 一致；填充条宽度/不定模式由 JS 控制）。 */
function progressHtml(): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;
    font-family:system-ui,sans-serif;font-size:13px;user-select:none}
  .wrap{padding:14px 16px;box-sizing:border-box;display:flex;flex-direction:column;gap:10px}
  .msg{font-size:13px;line-height:1.4;min-height:18px}
  .track{height:8px;border-radius:4px;background:#21262d;overflow:hidden;position:relative}
  .fill{height:100%;width:0%;background:#2f81f7;border-radius:4px;transition:width .15s linear}
  .fill.indeterminate{width:40%;position:absolute;animation:slide 1.2s ease-in-out infinite}
  @keyframes slide{0%{left:-40%}100%{left:100%}}
  .pct{font-size:12px;color:#8b949e;text-align:right}
  .hint{font-size:11px;color:#6e7681}
</style>
<body><div class="wrap">
  <div class="msg" id="msg">…</div>
  <div class="track"><div class="fill" id="fill"></div></div>
  <div class="pct" id="pct"></div>
  <div class="hint" id="hint"></div>
</div></body></html>`
}

/**
 * 显示（或复用）进度窗口。
 * @param onClose - 用户手动关闭窗口时触发的取消回调；程序主动隐藏不触发。
 */
export function showEngineProgress(onClose?: () => void): void {
  closeHandler = onClose ?? null
  if (progressWin !== null && !progressWin.isDestroyed()) {
    progressWin.show()
    progressWin.focus()
    return
  }
  const win = new BrowserWindow({
    width: 460,
    height: 150,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: t('prog.title'),
    backgroundColor: '#0d1117',
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  progressWin = win
  win.setMenuBarVisibility(false)
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(progressHtml())}`)
  win.webContents.once('did-finish-load', () => {
    updateEngineProgress('', null)
    const js = `document.getElementById('hint').textContent=${JSON.stringify(t('prog.hint'))}`
    void win.webContents.executeJavaScript(js).catch(() => undefined)
  })
  win.on('closed', () => {
    if (progressWin === win) progressWin = null
    const cb = closeHandler
    closeHandler = null
    if (cb !== null) cb()
  })
}

/**
 * 更新进度窗口内容。
 * @param message - 进度文字（已按当前语言本地化）。
 * @param pct - 0~100 的完成百分比；null 表示“不定进度”（流动动画，如检查/校验/安装中）。
 */
export function updateEngineProgress(message: string, pct: number | null): void {
  const win = progressWin
  if (win === null || win.isDestroyed()) return
  const fillClass = pct === null ? 'indeterminate' : ''
  const width = pct === null ? '' : `${Math.round(pct)}%`
  const pctText = pct === null ? '' : `${Math.round(pct)}%`
  const js = `(function(){
    var m=document.getElementById('msg');
    var f=document.getElementById('fill');
    var p=document.getElementById('pct');
    if(m)m.textContent=${JSON.stringify(message)};
    if(f){f.className='fill ${fillClass}';if(${JSON.stringify(width)})f.style.width=${JSON.stringify(width)};}
    if(p)p.textContent=${JSON.stringify(pctText)};
  })()`
  void win.webContents.executeJavaScript(js).catch(() => undefined)
}

/**
 * 主窗口任务栏进度条（Windows）。
 * @param value - 0~1 的完成比例；负值清除；indeterminate 为 true 时显示流动动画。
 */
export function setTaskbarProgress(value: number, indeterminate = false): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win === progressWin || win.isDestroyed()) continue
    try {
      if (value < 0) win.setProgressBar(-1)
      else if (indeterminate) win.setProgressBar(0.05, { mode: 'indeterminate' })
      else win.setProgressBar(Math.max(0, Math.min(1, value)))
    } catch {
      /* 忽略：无任务栏环境（如某些远程会话） */
    }
  }
}

/** 关闭进度窗口并清除任务栏进度（程序主动关闭，不触发取消回调）。 */
export function hideEngineProgress(): void {
  closeHandler = null
  setTaskbarProgress(-1)
  if (progressWin !== null && !progressWin.isDestroyed()) progressWin.close()
  progressWin = null
}
