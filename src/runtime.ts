/**
 * 运行时解析：确定用哪个 node 可执行文件、哪个 dsh bin 入口来拉起本地
 * `dsh web` 服务器，以及当前生效的 dsh 引擎版本。
 *
 * 运行时目录有两处来源：
 * 1. 安装目录内置：`resources/dsh-runtime`（随安装包分发，npm 扁平布局）。
 * 2. 用户数据目录覆盖：`<userData>/runtime-v<version>`（引擎更新通道下载
 *    解压而来，由 runtime-state.json 记录）。壳更新（NSIS 覆盖安装）不会
 *    触碰 userData，因此“桌面版更新”和“dsh 引擎更新”两条通道互不干扰。
 * @module dsh-desktop/runtime
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 运行时状态文件：记录 userData 中已更新的运行时版本与目录。 */
function runtimeStateFile(): string {
  return join(app.getPath('userData'), 'runtime-state.json')
}

/** 运行时状态。 */
export interface RuntimeState {
  version: string
  dir: string
  appliedAt: string
}

/** 读取运行时状态；不存在或目录失效（node.exe 或 dsh bin 缺失）时返回 null。 */
export function readRuntimeState(): RuntimeState | null {
  try {
    const parsed = JSON.parse(readFileSync(runtimeStateFile(), 'utf8')) as Partial<RuntimeState>
    if (typeof parsed.version === 'string' && typeof parsed.dir === 'string'
      && existsSync(join(parsed.dir, 'node', 'node.exe'))
      && existsSync(join(parsed.dir, 'dsh-deploy', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
      return parsed as RuntimeState
    }
  } catch {
    /* 无状态文件或损坏 */
  }
  return null
}

/** 写入运行时状态（记录应用了哪个引擎更新）。 */
export function writeRuntimeState(state: RuntimeState): void {
  mkdirSync(dirname(runtimeStateFile()), { recursive: true })
  writeFileSync(runtimeStateFile(), JSON.stringify(state, null, 2))
}

/** 删除运行时状态（恢复为使用随壳发布的内置引擎）。 */
export function removeRuntimeState(): void {
  try {
    rmSync(runtimeStateFile(), { force: true })
  } catch {
    /* 忽略 */
  }
}

/** 当前生效的运行时根目录：优先 userData 中已更新的运行时，否则安装目录内置。 */
export function resolveRuntimeRoot(): string {
  const state = readRuntimeState()
  if (state !== null) return state.dir
  return join(process.resourcesPath, 'dsh-runtime')
}

/** 当前生效的 dsh CLI 入口（运行时根目录下的标准 npm 布局）。 */
function activeDshBin(): string {
  return join(resolveRuntimeRoot(), 'dsh-deploy', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** 当前生效的独立 node 可执行文件。 */
function activeNodeExecutable(): string {
  return join(resolveRuntimeRoot(), 'node', 'node.exe')
}

/**
 * 解析要 spawn 的 node 可执行文件。
 * 优先级：DSH_DESKTOP_NODE 环境变量 > 当前生效运行时（userData 覆盖或内置）> 开发版 PATH 上的 `node`。
 * @returns 可执行文件路径或命令名。
 */
export function resolveNodeExecutable(): string {
  if (process.env.DSH_DESKTOP_NODE !== undefined && process.env.DSH_DESKTOP_NODE !== '') {
    return process.env.DSH_DESKTOP_NODE
  }
  if (app.isPackaged) {
    const bundled = activeNodeExecutable()
    if (!existsSync(bundled)) {
      throw new Error(`运行时 node.exe 缺失：${bundled}（请重新运行 npm run prepare:runtime 后打包）`)
    }
    return bundled
  }
  return 'node'
}

/**
 * 解析要 spawn 的 dsh CLI 入口。
 * 优先级：DSH_DESKTOP_DSH_BIN 环境变量 > 当前生效运行时 > 仓库构建产物。
 * @returns dsh bin 的绝对路径。
 */
export function resolveDshBin(): string {
  if (process.env.DSH_DESKTOP_DSH_BIN !== undefined && process.env.DSH_DESKTOP_DSH_BIN !== '') {
    return process.env.DSH_DESKTOP_DSH_BIN
  }
  if (app.isPackaged) {
    const bundled = activeDshBin()
    if (!existsSync(bundled)) {
      throw new Error(`运行时 dsh bin 缺失：${bundled}（请重新运行 npm run prepare:runtime 后打包）`)
    }
    return bundled
  }
  const dev = join(app.getAppPath(), '..', 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(dev)) {
    throw new Error(`仓库 dsh bin 缺失：${dev}（请先在仓库根目录运行 pnpm run build）`)
  }
  return dev
}

/** 当前生效的 dsh 引擎版本（userData 覆盖或内置运行时的 @deepseek-ai/dsh 版本），读取失败返回 undefined。 */
export function currentDshVersion(): string | undefined {
  try {
    const manifest = join(resolveRuntimeRoot(), 'dsh-deploy', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/** 安装目录内置的 dsh 运行时版本（开发模式返回 undefined）。 */
export function bundledDshVersion(): string | undefined {
  if (!app.isPackaged) return undefined
  try {
    const manifest = join(process.resourcesPath, 'dsh-runtime', 'dsh-deploy', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/** 删除一个运行时目录（尽力，Windows 上可能有占用）。 */
export function rmRuntimeDir(dir: string): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      /* 占用中，重试 */
    }
  }
}
