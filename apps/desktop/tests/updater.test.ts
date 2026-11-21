import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import vm from "node:vm"
import ts from "typescript"

/**
 * #437：更新源在运行中改回空要回落默认源 · 下载好的更新要能从渲染层触发「重启更新」。
 *
 * 跑的是真的 `src/main/updater.ts` 和 `src/main/ipc.ts`，electron / electron-updater 是 mock。
 * mock 的 autoUpdater 按 electron-updater 6.8 的语义记「当前的源」：`setFeedURL` 换成 generic，
 * `updateConfigPath = null` 丢掉覆盖、下次检查重新读 `app-update.yml`（AppUpdater.js 的 setter 和 loadUpdateConfig）。
 */

function transpile(filename: string): string {
  return ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
}

function load(filename: string, mocks: Record<string, unknown>): Record<string, unknown> {
  const exports: Record<string, unknown> = {}
  vm.runInNewContext(transpile(filename), {
    exports,
    console: { info() {}, log() {}, warn() {}, error() {} },
    require: (name: string) => {
      assert.ok(name in mocks, `未 mock 的依赖：${name}`)
      return mocks[name]
    },
  })
  return exports
}

const contract = load(path.resolve(import.meta.dirname, "../../../packages/platform/src/desktop/contract.ts"), {}) as {
  IPC: Record<string, string>
}

function setup() {
  const config = { updateUrl: "", autoLaunch: false }
  const feedsAtCheck: string[] = []
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {}
  const installs: unknown[][] = []
  let feed = "default"
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    setFeedURL(opts: { url: string }) {
      feed = opts.url
    },
    set updateConfigPath(value: string | null) {
      if (value == null) feed = "default"
    },
    on(event: string, fn: (arg?: unknown) => void) {
      ;(listeners[event] ??= []).push(fn)
    },
    checkForUpdates: async () => {
      feedsAtCheck.push(feed)
      return null
    },
    quitAndInstall: (...args: unknown[]) => installs.push(args),
  }
  const updater = load(path.resolve(import.meta.dirname, "../src/main/updater.ts"), {
    electron: { app: { isPackaged: true } },
    "electron-updater": { autoUpdater },
    "./config": { readConfig: () => config },
    "./login-item": { syncLoginItem() {} },
  }) as {
    checkForUpdates: (emit: (e: unknown) => void) => Promise<void>
    downloadedVersion: () => string | null
    quitAndInstall: () => Promise<void>
  }
  return {
    config,
    feedsAtCheck,
    installs,
    updater,
    emitUpdater: (event: string, arg?: unknown) => listeners[event]?.forEach((fn) => fn(arg)),
  }
}

test("运行中把 updateUrl 清空：下一次检查回落到 app-update.yml 的默认源，不用重启", async () => {
  const s = setup()
  await s.updater.checkForUpdates(() => {})
  s.config.updateUrl = "https://intranet.example/desktop"
  await s.updater.checkForUpdates(() => {})
  s.config.updateUrl = ""
  await s.updater.checkForUpdates(() => {})
  assert.deepEqual(s.feedsAtCheck, ["default", "https://intranet.example/desktop", "default"])
})

test("运行中换一个 updateUrl：下一次检查就用新的", async () => {
  const s = setup()
  s.config.updateUrl = "https://a.example/desktop"
  await s.updater.checkForUpdates(() => {})
  s.config.updateUrl = "https://b.example/desktop"
  await s.updater.checkForUpdates(() => {})
  assert.deepEqual(s.feedsAtCheck, ["https://a.example/desktop", "https://b.example/desktop"])
})

test("下载完的版本主进程记着：渲染层晚于事件挂上（登录页刷新、整页重载）也能问到", async () => {
  const s = setup()
  await s.updater.checkForUpdates(() => {})
  assert.equal(s.updater.downloadedVersion(), null)
  s.emitUpdater("update-downloaded", { version: "9.9.9" })
  assert.equal(s.updater.downloadedVersion(), "9.9.9")
})

test("quitAndInstall 静默安装并拉回（true, true）", async () => {
  const s = setup()
  await s.updater.quitAndInstall()
  assert.deepEqual(s.installs, [[true, true]])
})

test("IPC：updater:downloaded 返回主进程记着的版本（渲染层挂载时补问一次）", async () => {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const { registerIpc } = load(path.resolve(import.meta.dirname, "../src/main/ipc.ts"), {
    electron: {
      BrowserWindow: { getAllWindows: () => [] },
      ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
          handlers[channel] = fn
        },
        on() {},
      },
    },
    "@admin/platform/desktop/contract": contract,
    "./auth": {},
    "./config": { readConfig: () => ({}), writeConfig: () => ({}) },
    "./login-item": { syncLoginItem() {} },
    "./devices/registry": { onDeviceEvent() {} },
    "./print": {},
    "./updater": { checkForUpdates() {}, quitAndInstall() {}, downloadedVersion: () => "9.9.9" },
  }) as { registerIpc: (info: () => unknown) => void }
  registerIpc(() => ({}))
  const channel = contract.IPC.updaterDownloaded
  assert.ok(channel, "契约里没有 updater:downloaded 这条通道")
  assert.equal(await handlers[channel]?.(), "9.9.9")
})
