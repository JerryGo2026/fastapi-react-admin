import { app } from "electron"
import fs from "node:fs"
import path from "node:path"

/**
 * 开机自启与 `config.json` 的 `autoLaunch` 同步（#428）。
 *
 * 🔴 **开和关都要调**。原来只在 `autoLaunch === true` 时注册，改回 `false` 什么都不做 ——
 * 系统登录项一直留着，而 config.json 里明明写着 false，看不出哪里不对。
 * 所以启动时无条件同步一次（顺带把「被人手改过的登录项」拉回和配置一致），
 * `config:set` 改了 `autoLaunch` 时再同步一次。
 *
 * 平台差异：
 * - Windows / macOS：`app.setLoginItemSettings`（Windows 写 HKCU 的 Run 键，macOS 走登录项）
 * - Linux：Electron 的 `setLoginItemSettings` 在 Linux 上**是空操作**（文档只列了 macOS / Windows），
 *   走 XDG autostart：`$XDG_CONFIG_HOME/autostart/<可执行文件名>.desktop`
 *
 * 未打包（开发模式）一律不碰：那时 `process.execPath` 是 node_modules 里的 electron，
 * 登记上去就是开机弹一个空的 Electron 欢迎页。
 */
export function syncLoginItem(enabled: boolean): void {
  if (!app.isPackaged) return
  try {
    if (process.platform === "linux") syncLinuxAutostart(enabled)
    else app.setLoginItemSettings({ openAtLogin: enabled, args: [] })
  } catch (e) {
    // 登录项写不进去不该让应用起不来；但要留痕，否则「设了开机自启却没生效」无从查起
    console.warn(`[desktop] 同步开机自启失败（autoLaunch=${enabled}）:`, e instanceof Error ? e.message : e)
  }
}

/** desktop entry 规范：Exec 里带引号的参数要转义 `"` `` ` `` `$` `\` */
function quoteExec(p: string): string {
  return `"${p.replace(/(["`$\\])/g, "\\$1")}"`
}

function syncLinuxAutostart(enabled: boolean): void {
  // 文件名取可执行文件名（electron-builder.yml 的 executableName），不写死 —— 下游改名照样对
  const file = path.join(app.getPath("appData"), "autostart", `${path.basename(process.execPath)}.desktop`)
  if (!enabled) {
    fs.rmSync(file, { force: true })
    return
  }
  /*
   * ⚠️ AppImage 运行时 `process.execPath` 是 `/tmp/.mount_xxx/...` 这个临时挂载点，
   * 关掉应用就没了；要登记 `APPIMAGE` 环境变量指向的那个 .AppImage 文件。
   * electron-updater 更新 AppImage 时可能换文件名（名字里带版本号），所以每次启动都重写一遍。
   */
  const exec = process.env.APPIMAGE || process.execPath
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      "[Desktop Entry]",
      "Type=Application",
      `Name=${app.getName()}`,
      `Exec=${quoteExec(exec)}`,
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"),
    "utf8"
  )
}
