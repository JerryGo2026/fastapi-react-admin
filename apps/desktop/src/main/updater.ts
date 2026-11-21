import type { UpdaterEvent } from "@admin/platform/desktop/contract"
import { app } from "electron"

import { readConfig } from "./config"
import { syncLoginItem } from "./login-item"

/**
 * 自动更新。**两个源，按优先级**：
 *
 * 1. `userData/config.json` 里的 `updateUrl` —— generic provider，服务端只要一个
 *    能列目录的静态 HTTP 服务（现成的 IIS 就够）。交付给内网客户时用这个
 * 2. 没填 `updateUrl` 就用打包时写进 `app-update.yml` 的那个源
 *    （`electron-builder.yml` 的 `publish`，现在指向 GitHub Release）
 *
 * 🔴 以前只支持第 1 条：没配 `updateUrl` 就直接 `return null`，于是从 GitHub
 * Release 装下来的包**永远查不到更新**，而界面上显示的是「已是最新版本」——
 * 一个假阴性，看不出坏了。
 *
 * 惰性 import：开发模式下根本不加载它。
 */

type Emit = (event: UpdaterEvent) => void

let wired = false
/** 最近一次经 `error` 事件报出去的错误：electron-updater 失败时既发事件又 reject，catch 里据此去重 */
let lastEmittedError: unknown = null
/** 上一次检查有没有用 `setFeedURL` 覆盖成 updateUrl —— 清空时要撤掉 */
let feedOverridden = false
/** 已下载、等安装的版本。渲染层可能晚于 `downloaded` 事件才挂上监听（登录页刷新 / 整页重载），挂上时来问一次 */
let downloaded: string | null = null

export function downloadedVersion(): string | null {
  return downloaded
}

async function getUpdater() {
  // 开发模式没有 app-update.yml,强跑只会报一句误导人的错
  if (!app.isPackaged) return null
  /*
   * 🔴 `const { autoUpdater } = await import(...)` 在**正式包里拿到的是 undefined**。
   *
   * electron-updater 是 CommonJS，而主进程产物是 vite 打的 cjs bundle ——
   * 这条路径上 `import()` 回的是 `{ default: { autoUpdater } }`。两边都认才行。
   *
   * ⚠️ **开发模式永远撞不到这个 bug**：上面 `!app.isPackaged` 就早退了，
   * 根本不加载这个模块。正式包里的表现是
   * `Cannot read properties of undefined (reading 'setFeedURL')`。
   * （实测：下游项目的 0.0.x 正式包，2026-08-25）
   */
  const mod = (await import("electron-updater")) as unknown as {
    autoUpdater?: typeof import("electron-updater").autoUpdater
    default?: { autoUpdater?: typeof import("electron-updater").autoUpdater }
  }
  const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
  if (!autoUpdater) return null
  const { updateUrl } = readConfig()
  // 填了就覆盖成内网源；没填就用打包时写进 app-update.yml 的那个
  if (updateUrl) {
    autoUpdater.setFeedURL({ provider: "generic", url: updateUrl })
    feedOverridden = true
  } else if (feedOverridden) {
    /*
     * 🔴 运行中把 updateUrl 清空要**主动**撤掉覆盖（#437）。autoUpdater 是单例，`setFeedURL` 设进去的源
     * 一直留着 —— 原来「没填就不动 feed」在冷启动时对、在运行中清空时等于继续用上一个内网源，要重启才回落。
     * electron-updater 6.8 没有「恢复默认源」的公开方法；`updateConfigPath` 的 setter 会清掉 `clientPromise`、
     * 置空后下次检查按 `app.appUpdateConfigPath` 重新读 app-update.yml（AppUpdater.js 的 setter / loadUpdateConfig）。
     * 它在 d.ts 里标着 test only —— 升级 electron-updater 时跑一遍 `tests/updater.test.ts` 并核对这两处源码
     */
    ;(autoUpdater as unknown as { updateConfigPath: string | null }).updateConfigPath = null
    feedOverridden = false
  }
  autoUpdater.autoDownload = true
  // 下载完不要自动重启 —— 自助终端正在给用户办业务时弹重启是事故
  autoUpdater.autoInstallOnAppQuit = true
  return autoUpdater
}

export async function checkForUpdates(emitRaw: Emit): Promise<void> {
  // 失败一律进主进程日志：自动检查时渲染层未必有人在听这条事件（#428）
  const emit: Emit = (event) => {
    if (event.kind === "error") console.warn(`[desktop] 检查更新失败: ${event.message}`)
    emitRaw(event)
  }
  const updater = await getUpdater()
  if (!updater) {
    emit({ kind: "not-available" })
    return
  }
  if (!wired) {
    wired = true
    updater.on("checking-for-update", () => emit({ kind: "checking" }))
    updater.on("update-available", (i) => emit({ kind: "available", version: i.version }))
    updater.on("update-not-available", () => emit({ kind: "not-available" }))
    updater.on("download-progress", (p) => emit({ kind: "progress", percent: p.percent }))
    updater.on("update-downloaded", (i) => {
      downloaded = i.version
      emit({ kind: "downloaded", version: i.version })
    })
    updater.on("error", (e) => {
      lastEmittedError = e
      emit({ kind: "error", message: e.message })
    })
    /*
     * AppImage 装新版时，旧文件名里带版本号就删掉旧文件、按新包名落地（electron-updater 的 AppImageUpdater）。
     * autostart 的 Exec 写的是旧路径 —— 这里不跟着改，下次开机就指着一个不存在的文件，
     * 应用起不来，login-item.ts 那个「每次启动重写」也就永远没机会跑。
     */
    updater.on("appimage-filename-updated", (newPath: string) => {
      if (readConfig().autoLaunch === true) syncLoginItem(true, newPath)
    })
  }
  try {
    await updater.checkForUpdates()
  } catch (e) {
    /*
     * 🔴 失败必须是可见状态（根 CLAUDE.md 硬纪律 9）。这里最常见的失败是
     * **包里没有 app-update.yml**（打包时 `publish` 没配、或者用 `--dir` 出的包）——
     * electron-updater 直接抛。让它冒到 IPC 层的话渲染端拿到的是一个 rejected
     * promise，界面上通常什么都不显示；而 emit 一条 error，「检查更新」那一屏
     * 至少能说出原因。
     *
     * ⚠️ electron-updater 的 checkForUpdates 失败时**先发 `error` 事件再 reject 同一个对象** ——
     * 上面的监听已经报过一次了，这里再报就是每次失败两条日志、两条事件。只报监听没见过的
     * （比如事件接上之前就抛了的）。
     */
    if (e !== lastEmittedError) emit({ kind: "error", message: e instanceof Error ? e.message : String(e) })
  }
}

/** 启动后多久查第一次：让首屏和登录的请求先走，别和下载抢带宽 */
export const AUTO_CHECK_DELAY_MS = 30_000
/** 之后每隔多久查一次：终端机常常几个月不关机，只在启动时查等于永远停在那天的版本 */
export const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * 主进程自己定时检查更新（#428）。
 *
 * 🔴 原来**谁都不调** `checkForUpdates`：主进程只注册了 `updater:check` 这条 IPC，
 * 渲染层（web / platform）没有任何一处调 `desktop.updater.check()` —— 自动更新在本仓库的包里
 * 从来不会发生，而 release-notes 写着「自动更新正常」。放在主进程而不是渲染层：
 * 它不依赖用户登录、不依赖某个页面挂着，kiosk 机器上停在登录页也照样查。
 *
 * 下载完不弹重启（`autoInstallOnAppQuit`）：下次退出时静默装上。
 *
 * - 未打包：不安排（没有 app-update.yml，查了只会报一句误导人的错）
 * - `config.json` 的 `autoUpdate: false`：不查（每轮现读，改了不用重启）。没写这个键 = 查。
 *   给两类现场留的开关：要把版本钉住的客户机；以及沿用了本模板 `publish` 段、还没改成自己仓库的下游项目 ——
 *   不关的话它们会定时去拉**本仓库**的 Release 并在退出时装上。渲染层手动 `updater.check()` 不受影响
 * - macOS：不安排。包没签名，electron-updater 下完会因为校验不了代码签名拒绝安装 ——
 *   定时查等于每 4 小时下一遍完整 zip 再失败。签了名的下游项目把这一行删掉即可；
 *   渲染层手动 `updater.check()` 不受影响
 */
export function scheduleUpdateChecks(emit: Emit): void {
  if (!app.isPackaged) return
  if (process.platform === "darwin") return
  const run = () => {
    if (readConfig().autoUpdate === false) return
    // checkForUpdates 自己接住了 electron-updater 的失败；这里兜的是 import 本身炸了之类的意外，
    // 定时器回调里的 rejection 没人接会变成 unhandledRejection
    checkForUpdates(emit).catch((e: unknown) => {
      console.warn("[desktop] 检查更新失败:", e instanceof Error ? e.message : e)
    })
  }
  setTimeout(() => {
    run()
    setInterval(run, AUTO_CHECK_INTERVAL_MS)
  }, AUTO_CHECK_DELAY_MS)
}

export async function quitAndInstall(): Promise<void> {
  const updater = await getUpdater()
  /*
   * 🔴 必须显式 `(true, true)` = 静默安装 + 装完自动拉回来。
   *
   * `quitAndInstall()` 的 `isSilent` 默认是 `false`，而我们的 NSIS 是
   * `oneClick: false`（带向导，好处是首次安装能选目录）—— 两者一撞，
   * 拉起来的是**交互式安装向导**：应用退了、新版本没装上、界面上停在
   * 「下一步」等人点。自助终端/无人值守的机器上没人会去点。
   *
   * 实测判据（下游项目 2026-08-25 的落盘日志）：
   *   Install: isSilent: false, isForceRunAfter: true
   *   Update installer has already been triggered. Quitting application.
   * 之后 exe 仍然是旧版本 —— 安装器起来了，停在向导上。
   */
  // 拿不到更新器就抛：渲染层「重启更新」按钮据此显示失败（硬纪律 9），而不是点了没反应
  if (!updater) throw new Error("更新器不可用（开发模式或包里没有 app-update.yml）")
  updater.quitAndInstall(true, true)
}
