/**
 * 准备自包含运行时（打包前置步骤）：
 * 1. 下载独立 node.exe（默认 v22.19.0，可用 DSH_DESKTOP_NODE_VERSION 覆盖）到 .runtime/node；
 * 2. 用 `pnpm pack` 把 @deepseek-ai/dsh 及其 workspace 依赖闭包打成 tarball，
 *    再在独立的 .runtime/dsh-deploy 目录里 `npm install --omit=dev` 全部安装为
 *    file: 依赖——产物是 npm 扁平 node_modules、完全自包含、可独立删除；
 *    （pnpm 的 .pnpm 隔离布局会产生 2.2 万个超 260 字符的路径，NSIS 安装时会
 *    写失败；npm 扁平布局无此问题。）
 * 3. 用打包出的 node + dsh 做一次冒烟测试（隔离 DSH_HOME，端口 0），
 *    确认能打印就绪 URL；
 * 4. 生成 build/icon.png 应用图标。
 *
 * 幂等：产物已存在且校验通过时跳过；设 DSH_DESKTOP_FRESH=1 强制重建。
 * @module dsh-desktop/prepare-runtime
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { generateIcon } from './make-icon'

const scriptsDir = __dirname
const desktopRoot = resolve(scriptsDir, '..')
const repoRoot = resolve(desktopRoot, '..')
const runtimeDir = join(desktopRoot, '.runtime')
const cacheDir = join(desktopRoot, '.cache')
const nodeDir = join(runtimeDir, 'node')
const nodeExePath = join(nodeDir, 'node.exe')
/** 内置 npm 的 CLI 入口（引擎更新在用户机器上直接跑 npm install 官方包用）。 */
const npmCliPath = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
// deploy 产物目录：npm 扁平 node_modules 布局（node_modules/@deepseek-ai/dsh/lib/bin.js）。
// 不用旧目录名 `dsh`——早期共享 store 硬链接出的文件可能被运行中的 harness webui
// 锁定无法删除；npm 安装从自身缓存复制文件，产物完全独立可清理。
const dshDir = join(runtimeDir, 'dsh-deploy')
const packDir = join(cacheDir, 'pack')

/** 尽力删除目录（Windows 上可能被占用文件锁住，多次重试后忽略失败）。 */
function rmDirBestEffort(dir: string): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      console.warn(`[prepare] rm ${dir} attempt ${attempt + 1} failed: ${String(error)}`)
    }
  }
}

/** 下载文件到目标路径（Node 18+ 全局 fetch）。 */
async function downloadFile(url: string, target: string): Promise<void> {
  mkdirSync(dirname(target), { recursive: true })
  const response = await fetch(url)
  if (!response.ok || response.body === null) {
    throw new Error(`download failed ${response.status} ${response.statusText}: ${url}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(target, buffer)
  console.log(`[prepare] downloaded ${target} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`)
}

/** 运行 node --version；失败返回 null。 */
function nodeVersionOf(exe: string): string | null {
  try {
    return spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 15_000 }).stdout.trim() || null
  } catch {
    return null
  }
}

/** 确保 .runtime/node/（node.exe + npm）存在且版本符合要求。 */
async function ensureNode(force: boolean): Promise<string> {
  const version = process.env.DSH_DESKTOP_NODE_VERSION ?? '22.19.0'
  if (!force && existsSync(nodeExePath) && existsSync(npmCliPath)) {
    const current = nodeVersionOf(nodeExePath)
    if (current !== null && current.includes(`v${version}`)) {
      console.log(`[prepare] node ${current} already present, skipping download`)
      return nodeExePath
    }
    if (current !== null) console.log(`[prepare] existing node ${current} != desired v${version}, redownloading`)
  }
  const zip = join(cacheDir, `node-v${version}-win-x64.zip`)
  if (!existsSync(zip)) {
    await downloadFile(`https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`, zip)
  }
  rmSync(nodeDir, { recursive: true, force: true })
  // 提取整个 node 发行包（node.exe + npm）：引擎更新需要在用户机器上直接
  // 跑 npm install 官方包，所以运行时必须自带 npm。
  // 解压到中间目录，再把 node-v<ver>-win-x64 挪成 nodeDir（rename 目标不能已存在）。
  const tmpNode = `${nodeDir}.tmp`
  rmSync(tmpNode, { recursive: true, force: true })
  mkdirSync(tmpNode, { recursive: true })
  spawnSync('tar', ['-xf', zip, '-C', tmpNode], { stdio: 'inherit' })
  const extracted = join(tmpNode, `node-v${version}-win-x64`)
  const extractedNode = join(extracted, 'node.exe')
  if (!existsSync(extractedNode)) throw new Error(`tar 提取后找不到 ${extractedNode}`)
  rmSync(nodeDir, { recursive: true, force: true })
  renameSync(extracted, nodeDir)
  rmSync(tmpNode, { recursive: true, force: true })
  const current = nodeVersionOf(nodeExePath)
  if (current === null) throw new Error('node.exe 校验失败：提取后无法运行')
  if (!existsSync(npmCliPath)) throw new Error(`npm 缺失：${npmCliPath}`)
  console.log(`[prepare] node ready: ${current} (npm included)`)
  return nodeExePath
}

/** 一个 workspace 包的基本信息。 */
interface WorkspacePackage {
  name: string
  dir: string
  version: string
}

/**
 * 扫描仓库的 workspace 包（packages 下两级子目录、vendor、apps），返回 name → 包信息。
 */
function loadWorkspacePackages(): Map<string, WorkspacePackage> {
  const map = new Map<string, WorkspacePackage>()
  const scanDir = (dir: string, depth: number): void => {
    if (depth <= 0) return
    for (const entry of readdirSync(dir)) {
      const child = join(dir, entry)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(child)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      const manifestPath = join(child, 'package.json')
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
        if (typeof manifest.name === 'string' && manifest.name !== '') {
          map.set(manifest.name, { name: manifest.name, dir: child, version: String(manifest.version ?? '0.0.0') })
          continue // packages/*/* 已命中，不再下钻
        }
      }
      scanDir(child, depth - 1)
    }
  }
  scanDir(join(repoRoot, 'packages'), 2)
  scanDir(join(repoRoot, 'vendor'), 1)
  scanDir(join(repoRoot, 'apps'), 1)
  return map
}

/**
 * BFS 计算从 rootName 出发的 workspace 依赖闭包（deps + peers + optional）。
 * @returns 闭包内的 workspace 包名，BFS 顺序。
 */
function collectClosure(all: Map<string, WorkspacePackage>, rootName: string): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  const queue = [rootName]
  seen.add(rootName)
  while (queue.length > 0) {
    const name = queue.shift() as string
    const pkg = all.get(name)
    if (pkg === undefined) continue
    ordered.push(name)
    const manifest = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    for (const source of [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies]) {
      if (source === undefined) continue
      for (const dep of Object.keys(source)) {
        if (all.has(dep) && !seen.has(dep)) {
          seen.add(dep)
          queue.push(dep)
        }
      }
    }
  }
  return ordered
}

/** 把 workspace 包名转成安全的 tarball 文件名前缀。 */
function slugify(name: string): string {
  return name.replace(/^@/, '').replace(/\//g, '-')
}

/**
 * 确保 .runtime/dsh-deploy 是 @deepseek-ai/dsh 的自包含生产依赖树。
 * 做法：本地 pack 整个 workspace 闭包 → 全部作为 file: 依赖安装进独立目录。
 */
async function ensureDsh(force: boolean): Promise<string> {
  const bin = join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!force && existsSync(bin)) {
    console.log('[prepare] dsh runtime already present, skipping rebuild')
    return bin
  }
  // 早期用旧目录名 `dsh` 的部署残留可能被 webui 锁定；尽力清理，不影响构建。
  rmDirBestEffort(join(runtimeDir, 'dsh'))
  rmDirBestEffort(dshDir)

  const all = loadWorkspacePackages()
  const closure = collectClosure(all, '@deepseek-ai/dsh')
  console.log(`[prepare] workspace closure: ${closure.length} packages (${closure.join(', ')})`)

  // 1) 逐个 pack 闭包内的 workspace 包（幂等：tarball 已存在则跳过）。
  mkdirSync(packDir, { recursive: true })
  for (const name of closure) {
    const pkg = all.get(name)
    if (pkg === undefined) throw new Error(`closure 里的包找不到：${name}`)
    const tgz = join(packDir, `${slugify(name)}-${pkg.version}.tgz`)
    if (!existsSync(tgz)) {
      console.log(`[prepare] packing ${name}@${pkg.version}`)
      const result = spawnSync(
        'pnpm',
        ['--dir', repoRoot, '--filter', name, 'pack', '--out', tgz],
        { shell: true, stdio: 'inherit' },
      )
      if (result.status !== 0) throw new Error(`pnpm pack ${name} 失败（exit ${result.status ?? 'null'}）`)
    }
  }

  // 2) 组装独立安装目录：全部 workspace 依赖指向本地 tarball。
  mkdirSync(dshDir, { recursive: true })
  const tarballDir = join(dshDir, 'tarballs')
  mkdirSync(tarballDir, { recursive: true })
  const dependencies: Record<string, string> = {}
  for (const name of closure) {
    const pkg = all.get(name) as WorkspacePackage
    const tgzName = `${slugify(name)}-${pkg.version}.tgz`
    copyFileSync(join(packDir, tgzName), join(tarballDir, tgzName))
    dependencies[name] = `file:./tarballs/${tgzName}`
  }
  // 用 npm（扁平 node_modules）而非 pnpm 安装：pnpm 的 .pnpm/@pkg@hash/node_modules
  // 深层路径会超过 Windows 260 字符限制（实测 2.2 万个超长路径），导致 NSIS
  // 安装器写文件失败、装出来的应用缺运行时；npm 扁平布局最长路径 ≤ 260。
  // npm 11+ 的 allowScripts 需要在 package.json 里显式放行原生模块的构建脚本。
  writeFileSync(
    join(dshDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-runtime',
      private: true,
      version: '0.0.0',
      dependencies,
      allowScripts: {
        'node-pty': true,
        koffi: true,
        '@deepseek-ai/dsh-subprocess-local': true,
        '@google/genai': false,
        protobufjs: false,
      },
    }, null, 2),
  )

  // 3) 安装（npm 从自身缓存复制文件，不会与运行中的 webui 争用共享 store 硬链接）。
  console.log(`[prepare] npm install --omit=dev in ${dshDir}`)
  const install = spawnSync('npm', ['install', '--omit=dev'], { cwd: dshDir, shell: true, stdio: 'inherit' })
  if (install.status !== 0) throw new Error(`npm install 失败（exit ${install.status ?? 'null'}）`)
  // tarball 与 lockfile 只在安装时需要，从产物里清掉（避免打进安装包）。
  rmDirBestEffort(tarballDir)
  rmDirBestEffort(join(dshDir, 'package-lock.json'))

  // 4) 校验：bin、前端 dist、以及所有 workspace 包都来自本地（版本一致，非 registry 旧版）。
  if (!existsSync(bin)) throw new Error(`安装后缺少 dsh bin：${bin}`)
  const frontend = join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
  if (!existsSync(frontend)) throw new Error(`安装后缺少前端 dist：${frontend}`)
  let mismatches = 0
  for (const name of closure) {
    const pkg = all.get(name) as WorkspacePackage
    const installed = join(dshDir, 'node_modules', ...name.split('/'))
    if (!existsSync(installed)) {
      console.warn(`[prepare] 闭包包未安装：${name}`)
      mismatches++
      continue
    }
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as { version?: unknown }
    if (manifest.version !== pkg.version) {
      console.warn(`[prepare] ${name} 版本不符：本地 ${pkg.version} vs 安装 ${String(manifest.version)}`)
      mismatches++
    }
  }
  if (mismatches > 0) throw new Error(`${mismatches} 个 workspace 包未按本地版本安装`)
  console.log('[prepare] dsh runtime deployed (bin + frontend dist + local versions verified)')
  return bin
}

/** 冒烟测试：用打包出的 node 拉起打包出的 dsh web，确认打印就绪 URL 后结束。 */
function smokeTest(nodeExe: string, dshBin: string): Promise<void> {
  const smokeHome = join(runtimeDir, '.smoke-home')
  rmDirBestEffort(smokeHome)
  mkdirSync(smokeHome, { recursive: true })
  console.log('[prepare] smoke test: spawning bundled dsh web (isolated DSH_HOME) ...')
  return new Promise((resolveSmoke, rejectSmoke) => {
    const child = spawn(nodeExe, [dshBin, 'web', '--port', '0'], {
      env: { ...process.env, DSH_HOME: smokeHome, DSH_DESKTOP: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // 无论成功失败都要回收冒烟测试进程：不杀掉的话它的 stdout/stderr 管道会
    // 让本脚本的事件循环永不退出（npm 一直挂着）。
    const killChild = (): void => {
      if (child.pid !== undefined) {
        try {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
        } catch {
          /* 进程可能已退出 */
        }
      }
    }
    let done = false
    let stdoutText = ''
    let stderrText = ''
    const timer = setTimeout(() => finish(new Error('smoke test 超时（90s）')), 90_000)
    const finish = (error: Error | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      killChild()
      if (error !== null) rejectSmoke(error)
      else resolveSmoke()
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutText += chunk.toString()
      if (/dsh web:\s*https?:\/\/\S+/.test(stdoutText)) finish(null)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString()
    })
    child.on('error', (error) => finish(new Error(`spawn 失败：${error.message}`)))
    child.on('exit', (code, signal) => {
      if (!/dsh web:\s*https?:\/\/\S+/.test(stdoutText)) {
        finish(new Error(`dsh web 提前退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}）：${stderrText.slice(-1500)}`))
      }
    })
  })
}

/** 主流程。 */
async function main(): Promise<void> {
  const force = process.env.DSH_DESKTOP_FRESH === '1'
  console.log('[prepare] desktop root:', desktopRoot)
  console.log('[prepare] repository root:', repoRoot)
  const nodeExe = await ensureNode(force)
  const dshBin = await ensureDsh(force)
  await smokeTest(nodeExe, dshBin)
  // 冒烟测试的临时 DSH_HOME 不随安装包分发，测试后清理。
  rmDirBestEffort(join(runtimeDir, '.smoke-home'))
  console.log('[prepare] smoke test passed: bundled dsh web boots and prints its URL')
  generateIcon(join(desktopRoot, 'build', 'icon.png'))
  console.log('[prepare] done. runtime ready at', runtimeDir)
}

// 显式退出：冒烟测试子进程的管道会保持事件循环存活，不能依赖自然退出。
void main().then(() => {
  process.exit(0)
}).catch((error: unknown) => {
  console.error('[prepare] FAILED:', error)
  process.exit(1)
})
