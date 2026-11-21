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
export function syncLoginItem(raw: boolean, appImagePath?: string): void {
  if (!app.isPackaged) return
  // config.json 是可以手改的：`"autoLaunch": "false"` 是 truthy，Linux 上会反着写出 autostart、
  // Windows / macOS 上 setLoginItemSettings 直接抛（被下面接住，登录项永远撤不掉）
  const enabled = raw === true
  try {
    if (process.platform === "linux") syncLinuxAutostart(enabled, appImagePath)
    else app.setLoginItemSettings({ openAtLogin: enabled, args: [] })
  } catch (e) {
    // 登录项写不进去不该让应用起不来；但要留痕，否则「设了开机自启却没生效」无从查起
    console.warn(`[desktop] 同步开机自启失败（autoLaunch=${enabled}）:`, e instanceof Error ? e.message : e)
  }
}

/**
 * desktop entry 规范的 Exec 转义，**两层**：
 * 1. 引号规则：带引号的参数里 `"` `` ` `` `$` `\` 前面加反斜杠
 * 2. 字符串规则：整个值是 string 类型，读的时候先把 `\\` 还原成 `\` —— 所以第 1 步产生的每个反斜杠要再翻一倍
 *    （规范原文：字面的反斜杠要写四个，`$` 写成 `\\$`）。只转一层的话 GLib 读到 `\"` 是非法转义，整条值读不出来
 *
 * 另外 `%` 是字段码前缀，字面的 `%` 写成 `%%`。
 */
function quoteExec(p: string): string {
  const quoted = `"${p.replace(/%/g, "%%").replace(/(["`$\\])/g, "\\$1")}"`
  return quoted.replace(/\\/g, "\\\\")
}

function syncLinuxAutostart(enabled: boolean, appImagePath?: string): void {
  // 文件名取可执行文件名（electron-builder.yml 的 executableName），不写死 —— 下游改名照样对
  const file = path.join(app.getPath("appData"), "autostart", `${path.basename(process.execPath)}.desktop`)
  if (!enabled) {
    fs.rmSync(file, { force: true })
    return
  }
  /*
   * ⚠️ AppImage 运行时 `process.execPath` 是 `/tmp/.mount_xxx/...` 这个临时挂载点，
   * 关掉应用就没了；要登记 `APPIMAGE` 环境变量指向的那个 .AppImage 文件。
   * electron-updater 更新 AppImage 时会换文件名（名字里带版本号就删旧文件、按新包名落地），
   * 所以每次启动都重写一遍；更新器装完的那一刻也重写（`appimage-filename-updated` → `appImagePath`），
   * 否则下次开机 Exec 指着已经删掉的旧文件，应用起不来、也就没有「启动时重写」的机会。
   */
  const exec = appImagePath || process.env.APPIMAGE || process.execPath
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
