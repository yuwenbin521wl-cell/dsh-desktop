/**
 * dsh web 服务器拉起：spawn 独立 node 运行 dsh bin（`web --port 0`），从 stdout
 * 的 `dsh web: http://127.0.0.1:<port>` 行解析实际端口（端口 0 由操作系统分配，
 * 避免与用户已运行的 webui 或其它进程冲突），TCP 探活确认后交给主进程加载窗口。
 * 退出时先 SIGTERM，5 秒后仍未退出则 taskkill /T /F 兜底（Windows 上 SIGTERM 无法
 * 保证触发子进程的信号处理器）。
 * @module dsh-desktop/server
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** dsh web 就绪行的正则：`dsh web: http://127.0.0.1:PORT (...)`。 */
const URL_LINE = /dsh web:\s*(https?:\/\/\S+)/

/** 已拉起的 dsh web 服务器句柄。 */
export interface DshServerHandle {
  /** 服务器根 URL，如 http://127.0.0.1:45678。 */
  url: string
  /** 停止服务器并回收进程树；可安全重复调用。 */
  stop(): Promise<void>
}

/** 解析 URL 里的 hostname 和端口。 */
function parseUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url)
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port <= 0) throw new Error(`dsh web 返回了非法端口：${url}`)
  return { host: parsed.hostname, port }
}

/** TCP 探活，最多重试 tries 次、每次间隔 250ms。 */
function probePort(host: string, port: number, tries = 20): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const attempt = (left: number): void => {
      const socket = connect({ host, port })
      const done = (ok: boolean): void => {
        socket.destroy()
        if (ok) resolveProbe(true)
        else if (left <= 0) resolveProbe(false)
        else setTimeout(() => attempt(left - 1), 250)
      }
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
    }
    attempt(tries)
  })
}

/**
 * 停止子进程：先 SIGTERM 优雅退出，宽限期后 taskkill 强制结束进程树。
 * @param child - 要停止的子进程。
 */
function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.pid === undefined || child.exitCode !== null) {
      resolveStop()
      return
    }
    let done = false
    const finish = (): void => {
      if (!done) {
        done = true
        resolveStop()
      }
    }
    child.once('exit', finish)
    child.kill()
    setTimeout(() => {
      if (done) return
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => finish())
    }, 5000)
  })
}

/**
 * 拉起 dsh web 服务器并等待就绪。
 * @param nodeExe - node 可执行文件（打包版为 resources 里的 node.exe，开发版为 `node`）。
 * @param dshBin - dsh CLI 入口的绝对路径。
 * @param options - 可选参数。
 * @returns 就绪后的服务器句柄（含 URL）；超时或提前退出时 reject。
 */
export function startDshServer(
  nodeExe: string,
  dshBin: string,
  options: { timeoutMs?: number } = {},
): Promise<DshServerHandle> {
  const timeoutMs = options.timeoutMs ?? 60_000
  return new Promise((resolveStart, rejectStart) => {
    // 打包版把工作目录放到 userData（可写）；开发版沿用当前目录（仓库根附近）。
    const cwd = app.isPackaged ? app.getPath('userData') : process.cwd()
    // --no-open：dsh web 默认启动后会用系统默认浏览器打开自身页面（面向普通
    // 用户启动 `dsh web` 的场景）；桌面版自己有窗口，必须关掉这个行为，
    // 否则每次启动都会额外弹出一个浏览器标签。
    const child = spawn(nodeExe, [dshBin, 'web', '--port', '0', '--no-open'], {
      cwd,
      env: { ...process.env, DSH_DESKTOP: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let settled = false
    let stdoutText = ''
    let stderrText = ''
    const timer = setTimeout(() => {
      settle(new Error(`dsh web 启动超时（${timeoutMs}ms）`))
    }, timeoutMs)
    const settle = (error: Error | null, url?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== null) rejectStart(error)
      else resolveStart({ url: url!, stop: () => stopChild(child) })
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutText += chunk.toString()
      // 服务器输出落盘，便于排查运行期插件/工具错误（原只保留退出时的 stderr）。
      try { appendFileSync(join(app.getPath('userData'), 'dsh-server.log'), chunk) } catch { /* 忽略 */ }
      const match = URL_LINE.exec(stdoutText)
      if (match?.[1] === undefined) return
      const url = match[1]
      // URL 行打印后（Loader 树就绪）再 TCP 探活一次，确保窗口加载时服务一定可连。
      let parsed: { host: string; port: number }
      try {
        parsed = parseUrl(url)
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)))
        return
      }
      void probePort(parsed.host, parsed.port).then((ok) => {
        if (ok) settle(null, url)
        else settle(new Error(`dsh web 端口未就绪：${url}`))
      })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString()
      try { appendFileSync(join(app.getPath('userData'), 'dsh-server.log'), chunk) } catch { /* 忽略 */ }
    })
    child.on('error', (error) => {
      settle(new Error(`无法启动 dsh web：${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (!settled) {
        settle(new Error(`dsh web 提前退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}）：${stderrText.slice(-1200)}`))
      }
    })
  })
}
