/**
 * 主进程诊断日志：打包版没有控制台，把关键事件、异常、退出原因追加写入
 * userData/main-debug.log，用于定位“应用无故退出”类问题。
 * @module dsh-desktop/diag
 */

import { appendFileSync } from 'node:fs'

let logFile: string | null = null

/** 初始化日志文件路径（app ready 后调用）。 */
export function initDiag(file: string): void {
  logFile = file
  diag('=== dsh-desktop diag start ===')
}

/** 追加一行诊断日志；日志不可用时静默忽略。 */
export function diag(message: string): void {
  try {
    if (logFile !== null) appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* 日志失败不影响应用 */
  }
}

/** 安装全局异常/拒绝处理器，把未捕获异常写入诊断日志。 */
export function installDiagHandlers(): void {
  process.on('uncaughtException', (error) => {
    diag(`uncaughtException: ${String(error)}`)
    diag(error instanceof Error && error.stack !== undefined ? error.stack : '')
  })
  process.on('unhandledRejection', (reason) => {
    diag(`unhandledRejection: ${String(reason)}`)
    diag(reason instanceof Error && reason.stack !== undefined ? reason.stack : '')
  })
}
