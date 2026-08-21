/**
 * 预装插件（preinstalled plugins）：
 *
 * 桌面客户端首次运行时，会把这些插件自动写入用户的 web profile
 * （`<home>/profiles/web/package.json`），这样新安装的客户端自带识图、
 * 侧边栏增强、记忆进化等能力，无需用户手动逐个安装。
 *
 * 约定：
 *  - 只在 profile 尚不存在或尚未包含这些插件时写入；
 *  - 用户后来手动改动过 profile（安装了其他插件或改过 bundle）则视为
 *    已接管，不再覆盖；
 *  - 版本号跟随本文件；升级客户端后如需更新插件版本，改这里的值即可。
 *
 * @module dsh-desktop/preinstalled-plugins
 */

/** 预置 web profile 的 bundle 声明（`dsh.profile.bundles`）。 */
export const PREINSTALLED_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dshmarket',
  '@nanmicoder/dsh-agent-teams',
  '@linxin666/dsh-web-ui-all',
  'dsh-at-file',
  'dsh-better-sidebar',
  'dsh-memory-evolve',
  'dsh-vision-router',
]

/** 预置插件及其版本/来源声明（`dependencies`）。 */
export const PREINSTALLED_DEPENDENCIES: Readonly<Record<string, string>> = {
  '@linxin666/dsh-web-ui-all': '^0.2.2',
  '@nanmicoder/dsh-agent-teams': '^0.1.7',
  'dsh-at-file': 'https://github.com/omdsh-dev/dsh-at-file/archive/refs/tags/v0.6.5.tar.gz',
  'dsh-better-sidebar': '^0.13.1',
  'dsh-memory-evolve': 'github:csyangwen/dsh-memory-evolve',
  dshmarket: '^1.14.1',
  'dsh-vision-router': '1.7.3',
}

/** 预置 profile 的完整 package.json 内容。 */
export function preinstalledProfilePackageJson(): string {
  return `${JSON.stringify(
    {
      name: 'dsh-profile-web',
      private: true,
      dependencies: { ...PREINSTALLED_DEPENDENCIES },
      dsh: { profile: { bundles: [...PREINSTALLED_BUNDLES] } },
    },
    null,
    2,
  )}\n`
}
