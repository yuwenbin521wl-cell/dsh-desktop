# DeepSeek Harness 桌面版（Windows 客户端）

把 DeepSeek Harness 装进桌面的 Electron 客户端：内置拉起本地 `dsh web` 服务器，在桌面窗口里嵌入 Web UI（不再依赖浏览器标签页），并支持自我检查更新——发现新版本时弹出对话框询问“是否更新”，确认后才下载，下载完再询问是否重启安装。

该目录**刻意不加入 pnpm workspace**：它使用独立的依赖树（`npm install`），安装或升级桌面客户端都不会影响你正在使用的 harness 仓库；它只在构建时通过 `pnpm deploy` 消费仓库产物。

**数据目录（DSH_HOME）独立**：桌面版**始终**使用自己的 DSH_HOME——默认 `<userData>/home`（即 `%APPDATA%\dsh-desktop\home`），**不继承**外部 `DSH_HOME` 环境变量（它通常指向 web 版的 `~/.dsh`；两个 dsh 实例并发写同一会话文件会导致日志损坏 `corrupt session log: seq gap`）。历史会话、模型配置、API key 互不相通。如需覆盖，设置桌面版专属的 `DSH_DESKTOP_HOME` 环境变量（例如刻意指向 web 版目录以共享）；想沿用 web 版配置时，可手动把 `~/.dsh` 下的 `credentials` 等文件复制到桌面版数据目录。

## 环境要求

- Windows 10/11 x64。
- 仓库根目录可用的 Node.js >= 22.19 与 pnpm >= 9（harness 本身也需要）。
- 网络：npm、nodejs.org（下载内置独立 Node 运行时）；更新源默认 GitHub Releases，可覆盖（见下文）。

## 快速开始（开发模式）

```sh
cd desktop
npm install        # 安装 electron + electron-builder + electron-updater
npm run dev        # 编译外壳，并用仓库已构建的 dsh（apps/cli/lib/bin.js）运行
```

`npm run dev` 会拉起仓库自身的 `dsh web`（请先至少执行过一次仓库根的 `pnpm run build`），并在桌面窗口打开 UI；端口由操作系统分配（`--port 0`），不会和你正在跑的 3080 webui 冲突。

## 构建安装包

```sh
cd desktop
npm run dist       # tsc 编译 + 准备运行时 + electron-builder 打 NSIS 包（不上传）
```

`npm run dist` 分三步：

1. `npm run build` 把 Electron 主进程编译到 `dist/`。
2. `npm run prepare:runtime` 下载独立 `node.exe`（默认 v22.19.0，可用 `DSH_DESKTOP_NODE_VERSION` 覆盖），用 `pnpm pack` 把 `@deepseek-ai/dsh` 在本仓库内的整个 `@deepseek-ai/*` workspace 依赖闭包打成 tarball，再把这些 tarball 与全部 registry 依赖安装进 `.runtime/`（隔离 pnpm store + copy 导入，产物完全自包含、不会与你正在运行的 webui 争用共享 store 硬链接），并用隔离的 `DSH_HOME` 冒烟测试打包出的服务器能打印就绪 URL。
3. `electron-builder` 产出 `release/DeepSeek Harness Setup-<version>.exe`（NSIS，按用户安装、可选安装目录）与 `release/latest.yml`（更新清单）。

安装包完全自包含：独立 Node 运行时与整套 dsh 运行时都放在 `resources/dsh-runtime/`（asar 之外，因为独立 node.exe 读不了 asar），一次安装、一次更新同时覆盖外壳与 harness 本体。

## 自更新的工作方式（两条独立通道）

更新拆成两条完全独立的通道——**桌面版（壳）** 和 **dsh 引擎（运行时）** 各自版本、各自更新，互不干扰：

1. **桌面版更新**（菜单“帮助 → 检查更新…”）：向 `electron-updater` 查询新版安装包。发现新版本弹“发现新版本 vX，是否立即下载并更新？”，确认后下载，下载完再询问是否重启安装。更新源来自 `electron-builder.yml` 的 `publish` 段，打包时写入安装包的 `app-update.yml`（GitHub Releases provider，owner `deepseek-ai`、repo `deepseek-harness`）。
2. **dsh 引擎更新**（菜单“帮助 → 检查引擎更新…”）：向引擎源查询新版 `dsh-runtime-vX.zip`（完整的 node.exe + dsh 依赖树）。发现新版弹“检测到新的 dsh 引擎 vX（当前 vY）”，确认后下载、sha256 校验、停掉本地服务器、把运行时换入 `<userData>/runtime-vX`、询问是否重启。重启（或选“稍后”，会直接以新引擎拉起服务器）后新引擎生效。桌面版更新从不触碰 `<userData>`，两条通道不会互相覆盖。菜单“帮助 → 恢复内置引擎…”可随时回退到随壳发布的引擎版本（与壳最适配的版本）。

引擎通道（“检查引擎更新…”）每次启动和每 6 小时查询**官方 npm `@deepseek-ai/dsh`** 的最新版本——官方发布节奏，新版本一落地就能感知；然后按固定模式从 GitHub Releases 下载对应版本的运行时 zip：`https://github.com/<repo>/releases/download/dsh-engine-v<版本>/dsh-runtime-v<版本>.zip`（可选附带 `.sha256` 校验文件）。用 `DSH_DESKTOP_RUNTIME_REPO=<owner>/<repo>` 环境变量（或改 `src/runtime-updater.ts` 里的 `RUNTIME_RELEASE_REPO` 常量后重新打包）指向你的发布仓库；`DSH_DESKTOP_RUNTIME_URL`（自建源：`latest.json` + zip）优先级最高。

运行时 zip 由 **engine-sync 自动构建 Action** 生成（见 `desktop/ci/engine-sync.yml`）：把它复制到你的发布仓库 `.github/workflows/` 下，它会定时（每 6 小时）+ 手动触发：拉官方 harness 最新代码 → 构建完整运行时 → 发布 `dsh-runtime-vX.zip` + `.sha256` 到 `dsh-engine-vX` Release。之后桌面版**全自动**更新引擎——你不需要手动构建或同步。

壳更新源可在运行时覆盖以适配其它网络或联调：`DSH_DESKTOP_UPDATE_URL=http://host/feed` 切换到 generic 源（自建服务器，或国内常用的 `ghproxy.com` 等 GitHub 加速代理），该源需提供 `latest.yml` 与安装包；开发模式（未打包）下，把 `dev-app-update.yml.example` 复制为 `dev-app-update.yml`，`npm run dev` 即会启用壳更新检查（forceDevUpdateConfig），另开终端跑 `node scripts/dev-update-feed.mjs` 模拟“发现新版本”。引擎通道联调用 `node scripts/dev-runtime-feed.mjs` 起本地引擎源，再以 `DSH_DESKTOP_RUNTIME_URL` 启动应用。

## 发布新版本

给仓库打 `dsh-desktop-v*` 标签（如 `dsh-desktop-v0.1.0`）并推送；`.github/workflows/desktop-release.yml` 会在 Windows runner 上构建并发布安装包与 `latest.yml`（壳通道）**以及** `dsh-runtime-vX.zip`（引擎通道）到对应 tag 的 GitHub Release（草稿）。electron-updater 按应用 `version` 字段比较版本，因此发版时要把 `desktop/package.json` 的版本与 harness 一起递增；引擎 zip 的版本取内置 `@deepseek-ai/dsh` 的版本。预发布版（rc 等）默认被 electron-updater 跳过：测试时把 Release 标记为 latest，或用环境变量把两个通道分别指向 generic 源。

## 签名与 SmartScreen

未签名的 NSIS 安装包会触发 Windows SmartScreen 警告。需要签名时，在 `npm run dist` 前设置 `CSC_LINK`（`.pfx` 路径或 `base64:` 前缀）与 `CSC_KEY_PASSWORD`，并在 GitHub Action 中配置相同 secrets。electron-updater 安装 NSIS 更新本身不要求签名，但首次启动没有签名会有 SmartScreen 提示。

## 网络说明

`desktop/.npmrc` 把 Electron 与 electron-builder 的二进制下载指向 npmmirror（大陆网络通常无法直连 GitHub）；能直连 GitHub 的环境可删除该文件后重装依赖。内置 Node 运行时从 nodejs.org 下载。运行时的更新检查需要能访问你的更新源——上面的环境变量覆盖就是大陆网络的出口。

## 开发中修复过的已知问题

- **NSIS 安装后运行时文件缺失**（启动报"打包版 node.exe 缺失"）：pnpm 的隔离布局（`node_modules/.pnpm/@pkg@hash/node_modules/...`）会产生约 2.2 万条超过 Windows 260 字符路径限制的文件，NSIS 安装时写文件失败被静默跳过，导致装出来的应用缺运行时。已修复：运行时改用 npm 安装（扁平 `node_modules`，最长路径 ≤ 260），安装包也从约 682MB 降到约 185MB。
- **关闭窗口时应用崩溃**（托盘创建崩溃）：electron-builder 会自动排除 `build/` 目录（它是 buildResources），`build/icon.png` 从未被打进应用包；关闭窗口懒创建托盘时 `new Tray()` 因图标缺失抛异常。已修复：图标改走 `extraResources`（`resources/icon.png`），并给托盘创建加 try/catch 容错。
- **更新安装后新版不自动启动**：`autoUpdater.quitAndInstall(true, false)` 不会传 `--force-run`，NSIS 安装器装完不会启动应用。已修复：改传 `quitAndInstall(true, true)`。
- **退出流程不能强杀进程**：`before-quit` 里用 `app.exit(0)` 可能打断 electron-updater 的退出/安装序列；应使用 `app.quit()` 并让第二次 `before-quit` 自然放行。
- **对已安装版本静默重装是空操作**：NSIS 检测到已安装会静默跳过；测试重装前先卸载（或删除 `HKCU\Software\<app-guid>` 与 `HKCU\...\Uninstall\<guid>` 注册表项）。
- **更新模式跳过未变化文件**：更新安装只覆盖变化的文件、跳过内容相同的（例如 `DeepSeek Harness.exe` 时间戳可能不变）——这是预期行为，真正变化的是 `app.asar` 内的应用代码。

## 目录结构

- `src/main.ts` — 应用生命周期、单实例锁、窗口、菜单、托盘、退出时回收服务器进程树。
- `src/server.ts` — spawn `dsh web --port 0`，解析打印的 URL，TCP 探活，退出时 taskkill 兜底。
- `src/runtime.ts` — 打包版 / 开发版的 node 与 dsh bin 路径解析，以及 userData 覆盖的运行时根目录。
- `src/updater.ts` — electron-updater 接线与中文更新提示（壳通道）。
- `src/runtime-updater.ts` — dsh 引擎更新通道：检查源、下载、sha256 校验、换入 userData、重启提示。
- `src/diag.ts` — 主进程诊断日志（`<userData>/main-debug.log`），用于排查问题。
- `scripts/prepare-runtime.ts` — 生成 `.runtime/`（node + 部署后的 dsh 树）与图标。
- `scripts/build-runtime-zip.ts` — 把 `.runtime/` 打成可发布的 `dsh-runtime-vX.zip`。
- `scripts/make-icon.ts` — 零依赖 PNG 图标生成器。
- `scripts/dev-update-feed.mjs` — 本地模拟壳更新源，演示“发现新版本”提示。
- `scripts/dev-runtime-feed.mjs` — 本地模拟引擎更新源（`latest.json` + 运行时 zip），演示引擎更新。
