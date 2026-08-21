# DeepSeek Harness Desktop

A Windows desktop client for DeepSeek Harness: an Electron shell that boots the local `dsh web` server, embeds the Web UI in a desktop window (no browser tab), and self-checks for updates from GitHub Releases, prompting before it downloads or installs anything.

This package is intentionally **not** part of the pnpm workspace: it keeps its own dependency tree (`npm install`) so installing or updating the desktop client never disturbs the harness checkout you are developing with. It only consumes the repository at build time through `pnpm deploy`.

**Data (DSH_HOME) is isolated**: the desktop client always uses its own DSH_HOME — `<userData>/home` (i.e. `%APPDATA%\dsh-desktop\home`) by default — and does **not** inherit the ambient `DSH_HOME` environment variable (which usually points at the web UI's `~/.dsh`; two dsh instances writing the same session log concurrently corrupt it with `corrupt session log: seq gap`). Sessions, model config and API keys do not leak across. To override, set the desktop-specific `DSH_DESKTOP_HOME` environment variable (e.g. point it at the web UI's directory to deliberately share); to reuse web UI config, copy e.g. `credentials` from `~/.dsh` into the desktop data directory.

## Requirements

- Windows 10/11 x64.
- Node.js >= 22.19 and pnpm >= 9 at the repository root (the workspace itself needs them anyway).
- Network access to npm, nodejs.org (downloads the bundled standalone Node runtime) and, unless you override the update feed, GitHub Releases.

## Quick start

```sh
cd desktop
npm install        # installs electron + electron-builder + electron-updater
npm run dev        # build the shell and run it against the repo's built dsh (apps/cli/lib/bin.js)
```

`npm run dev` spawns the repository's own `dsh web` (you must have run `pnpm run build` at the repository root at least once) and opens the UI in a desktop window on an OS-assigned port, so it never collides with an already running web UI on port 3080.

## Vision / image recognition setup

The desktop client bundles the [`dsh-vision-router`](https://www.npmjs.com/package/dsh-vision-router) plugin (auto-installed into the desktop profile on first run) so image-capable turns work out of the box. By default it falls back to the free, keyless OVH anonymous vision endpoints (rate-limited); for reliable, higher-throughput recognition, configure your own vision backend key.

The plugin reads vision API keys from **either**:

1. **The DSH credentials file** (recommended) — the same `.credentials.yaml` DSH already reads:
   - Web UI: `~/.dsh/.credentials.yaml`
   - Desktop: `%APPDATA%\dsh-desktop\home\.credentials.yaml` (isolated `DSH_HOME`)
2. **Environment variables** — named by the `apiKeyEnv` field of each `httpProviders` entry.

Example — enable the built-in Zhipu (`glm-4v-flash`) and DashScope (`qwen-vl`) backends. Add to your credentials file:

```yaml
ZHIPU_API_KEY: your-zhipu-key
DASHSCOPE_API_KEY: your-dashscope-key
```

Or, equivalently, set them as user environment variables:

```powershell
setx ZHIPU_API_KEY "your-zhipu-key"
setx DASHSCOPE_API_KEY "your-dashscope-key"
```

> **Important**: environment variables set via `setx` or the Control Panel are picked up only by **newly started** processes. A desktop client (and the `dsh web` it spawns) that is already running keeps the environment snapshot it launched with — you must fully quit and reopen the client after setting the variables. The credentials-file route does **not** have this limitation: DSH re-reads it at runtime, so it works immediately and survives restarts. Because the desktop client uses an isolated `DSH_HOME`, its keys must live in the desktop credentials file (or the desktop's own environment), not the web UI's.

Free vision key sources and full configuration options are documented in the plugin's [README](https://www.npmjs.com/package/dsh-vision-router).

## Build the installer

```sh
cd desktop
npm run dist       # tsc build + prepare runtime + electron-builder NSIS (no publish)
```

`npm run dist` runs three steps:

1. `npm run build` compiles the Electron main process to `dist/`.
2. `npm run prepare:runtime` downloads a standalone `node.exe` (v22.19.0 by default, override with `DSH_DESKTOP_NODE_VERSION`), packs the whole `@deepseek-ai/*` workspace dependency closure of `@deepseek-ai/dsh` from this checkout with `pnpm pack`, installs those tarballs plus all registry dependencies into `.runtime/` (isolated pnpm store, copy import — so the tree is fully self-contained and never hard-linked against your running web UI), and smoke-tests the bundled server with an isolated `DSH_HOME` before packaging anything.
3. `electron-builder` produces `release/DeepSeek Harness Setup-<version>.exe` (NSIS, per-user, allows choosing the install directory) plus `release/latest.yml` — the update manifest.

The installer is fully self-contained: it ships the standalone Node runtime and the whole dsh runtime under `resources/dsh-runtime/` (outside the asar, because a standalone `node.exe` cannot read asar), so one install and one update covers the shell and the harness together.

## How self-update works

## How self-update works (two independent channels)

Updates are split into two independent channels — the desktop shell and the bundled dsh engine are versioned and updated separately:

1. **Desktop shell update** (Help → 检查更新…): asks `electron-updater` for a newer installer. When one exists it shows "发现新版本 vX，是否立即下载并更新？"; only after you confirm does it download, and once downloaded it asks again before restarting. The feed comes from the `publish` section of `electron-builder.yml`, baked into the installer as `app-update.yml` (GitHub Releases provider, owner `deepseek-ai`, repo `deepseek-harness`).
2. **dsh engine update** (Help → 检查引擎更新…): asks the runtime feed for a newer `dsh-runtime-vX.zip` (the whole `node.exe` + dsh dependency tree). It shows "检测到新的 dsh 引擎 vX（当前 vY）"; after confirmation it downloads the zip, verifies the sha256, stops the local server, swaps the runtime into `<userData>/runtime-vX`, and asks whether to restart. Restarting (or choosing 稍后, which restarts the server with the new engine) activates the new engine. Shell updates never touch `<userData>`, so the two channels never fight. Help → 恢复内置引擎… restores the engine that shipped with the shell (the version most compatible with it) whenever you want to roll back a manual engine update.

Runtime feed (engine channel) checks the **official npm `@deepseek-ai/dsh`** version on every launch and every 6h — the official release cadence, so new engine versions are detected as soon as they land — then downloads the matching runtime zip from a GitHub Release at the fixed pattern `https://github.com/<repo>/releases/download/dsh-engine-v<version>/dsh-runtime-v<version>.zip` (plus an optional `.sha256`). Set `DSH_DESKTOP_RUNTIME_REPO=<owner>/<repo>` (or the constant `RUNTIME_RELEASE_REPO` in `src/runtime-updater.ts`) to point at your publishing repo; `DSH_DESKTOP_RUNTIME_URL` (a static `latest.json` + zip) overrides everything.

The runtime zip is built automatically by the `engine-sync` GitHub Action (see `desktop/ci/engine-sync.yml`): copy it into your publishing repository's `.github/workflows/`, and it periodically checks out the official harness, builds the full runtime, and publishes `dsh-runtime-vX.zip` + `.sha256` to a `dsh-engine-vX` Release. The desktop app then updates the engine fully automatically — no manual builds.

For the shell feed: `DSH_DESKTOP_UPDATE_URL=http://host/feed` switches to a generic provider serving `latest.yml` plus the installer (works for a self-hosted feed or a GitHub proxy such as `ghproxy.com` in mainland China). In dev (unpackaged), copy `dev-app-update.yml.example` to `dev-app-update.yml` and `npm run dev` will use that feed via `forceDevUpdateConfig`; run `node scripts/dev-update-feed.mjs` to serve a fake newer shell version locally. For the engine feed in dev testing, run `node scripts/dev-runtime-feed.mjs` (serves `latest.json` + a runtime zip) and start the app with `DSH_DESKTOP_RUNTIME_URL`.

## Releasing an update

Tag the repository with `dsh-desktop-v*` (e.g. `dsh-desktop-v0.1.0`) and push; `.github/workflows/desktop-release.yml` builds on a Windows runner and publishes the installer plus `latest.yml` (shell channel) **and** the `dsh-runtime-vX.zip` (engine channel) to the GitHub Release for that tag (draft). electron-updater compares versions with the app's `version` field, so bump `desktop/package.json` together with the harness release; the engine zip is versioned by the bundled `@deepseek-ai/dsh` version. For prerelease testing, either mark the GitHub Release as latest or point the feeds at generic URLs; by default `electron-updater` skips prereleases.

## Signing and SmartScreen

Unsigned NSIS installers trigger Windows SmartScreen warnings. To sign, set `CSC_LINK` (path or `base64:` of the `.pfx`) and `CSC_KEY_PASSWORD` before `npm run dist`, and set the same secrets in the GitHub Action. electron-updater does not require a signature to install NSIS updates, but SmartScreen will warn on first launch without one.

## Network notes

`desktop/.npmrc` points Electron and electron-builder binary downloads at npmmirror because GitHub is often unreachable from mainland China; delete it and reinstall in environments with direct GitHub access. The bundled Node runtime is downloaded from nodejs.org. The runtime update check itself needs whatever network can reach your update feed — the env override above is the escape hatch for China networks.

## Known issues fixed during development

- **NSIS installer silently drops runtime files** ("打包版 node.exe 缺失" after install): pnpm's isolated layout (`node_modules/.pnpm/@pkg@hash/node_modules/...`) produces ~22k paths longer than Windows' 260-char MAX_PATH, and NSIS fails to write them, leaving the installed app without its bundled runtime. Fixed by installing the runtime with npm (flat `node_modules`, longest path ≤ 260) — the installer also shrank from ~682 MB to ~185 MB.
- **App dies when closing the window (tray)**: electron-builder auto-excludes the `build/` directory (it is `buildResources`), so `build/icon.png` was never packaged into the app; `new Tray()` threw when the window was closed and the tray was created lazily. Fixed by shipping the icon via `extraResources` (`resources/icon.png`) and wrapping tray creation in try/catch.
- **New version does not auto-launch after update**: `autoUpdater.quitAndInstall(true, false)` does not pass `--force-run`, so the NSIS installer finishes without starting the app. Call `quitAndInstall(true, true)` instead.
- **Quit sequence must not force-kill**: using `app.exit(0)` inside `before-quit` can interrupt electron-updater's quit/install sequence; use `app.quit()` and let the second `before-quit` pass through.
- **Silent reinstall of an existing install is a no-op**: NSIS skips silently when it detects an existing installation; uninstall first (or remove `HKCU\Software\<app-guid>` and `HKCU\...\Uninstall\<guid>`) before reinstalling for tests.
- **NSIS update mode skips unchanged files**: an update install overwrites changed files but leaves identical ones (e.g. the `DeepSeek Harness.exe` timestamp may stay old) — this is expected; what changes is the app code inside `app.asar`.

## Layout

- `src/main.ts` — app lifecycle, single-instance lock, window, menu, tray, server cleanup.
- `src/server.ts` — spawns `dsh web --port 0`, parses the printed URL, probes TCP, kills the process tree on quit.
- `src/runtime.ts` — resolves the standalone node and dsh bin for packaged vs dev mode, and the userData-override runtime root.
- `src/updater.ts` — electron-updater wiring and the Chinese update prompts (shell channel).
- `src/runtime-updater.ts` — dsh engine update channel: feed check, download, sha256 verify, swap, restart prompts.
- `src/diag.ts` — main-process diagnostic log (`<userData>/main-debug.log`) for troubleshooting.
- `scripts/prepare-runtime.ts` — builds `.runtime/` (node + deployed dsh tree) and the icon.
- `scripts/build-runtime-zip.ts` — packs `.runtime/` into the publishable `dsh-runtime-vX.zip`.
- `scripts/make-icon.ts` — dependency-free PNG icon generator.
- `scripts/dev-update-feed.mjs` — local fake shell-update feed to demo the update prompt.
- `scripts/dev-runtime-feed.mjs` — local fake engine feed (`latest.json` + runtime zip) to demo the engine update.
