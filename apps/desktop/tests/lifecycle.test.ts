import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import vm from "node:vm"
import ts from "typescript"

/**
 * #428：主进程启动时的两件事 —— 自动检查更新、开机自启与 config.json 同步。
 *
 * 跑的是真的 `src/main/index.ts`：Electron / electron-updater / fs 用 mock，
 * `./config` `./ipc` `./window` 这类与本题无关的模块用桩，**其余相对路径按真文件递归加载**，
 * 所以 index.ts 自己新拆出去的模块（登录项、定时检查）跑的是真代码。
 * 没在打包产物里跑：`app.isPackaged`、系统登录项、真的更新源都是 mock。
 */

type Timer = { fn: () => void; ms: number; repeat: boolean }

function transpile(filename: string): string {
  return ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
}

function makeLoader(mocks: Record<string, unknown>, globals: Record<string, unknown>) {
  const cache = new Map<string, unknown>()
  function loadFile(filename: string): unknown {
    if (cache.has(filename)) return cache.get(filename)
    const exports: Record<string, unknown> = {}
    cache.set(filename, exports)
    vm.runInNewContext(transpile(filename), {
      ...globals,
      exports,
      require: (name: string) => {
        if (name in mocks) return mocks[name]
        assert.ok(name.startsWith("./"), `未 mock 的依赖：${name}`)
        return loadFile(path.resolve(path.dirname(filename), `${name}.ts`))
      },
    })
    return exports
  }
  return loadFile
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

const contract = makeLoader({}, {})(
  path.resolve(import.meta.dirname, "../../../packages/platform/src/desktop/contract.ts")
) as { IPC: Record<string, string> }

interface BootOptions {
  packaged?: boolean
  platform?: string
  autoLaunch?: boolean
  appImage?: string
  checkFails?: boolean
  /** 叠在默认 config.json 上的字段（手改出来的非布尔值也走这里） */
  config?: Record<string, unknown>
}

async function boot(opts: BootOptions = {}) {
  const { packaged = true, platform = "win32", autoLaunch = false, appImage, checkFails = false, config = {} } = opts
  const loginItems: Array<Record<string, unknown>> = []
  const timers: Timer[] = []
  const warnings: string[] = []
  const events: unknown[] = []
  const written: Record<string, string> = {}
  const removed: string[] = []
  let checks = 0
  let updaterImported = false

  const listeners: Record<string, Array<(arg?: unknown) => void>> = {}
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    setFeedURL() {},
    on(event: string, fn: (arg?: unknown) => void) {
      ;(listeners[event] ??= []).push(fn)
    },
    // 同 electron-updater：失败时既发 error 事件又 reject
    checkForUpdates: async () => {
      checks++
      if (checkFails) {
        const err = new Error("net::ERR_NAME_NOT_RESOLVED")
        listeners.error?.forEach((fn) => fn(err))
        throw err
      }
      listeners["update-not-available"]?.forEach((fn) => fn())
      return null
    },
    quitAndInstall() {},
  }

  const app = {
    isPackaged: packaged,
    requestSingleInstanceLock: () => true,
    on() {},
    quit() {},
    whenReady: () => Promise.resolve(),
    getVersion: () => "1.2.3",
    getName: () => "Admin Desktop",
    getPath: (name: string) => (name === "appData" ? "/home/u/.config" : `/home/u/.config/Admin Desktop`),
    setLoginItemSettings: (settings: Record<string, unknown>) => loginItems.push(settings),
  }

  const mocks: Record<string, unknown> = {
    electron: { app, BrowserWindow: { getAllWindows: () => [] } },
    get "electron-updater"() {
      updaterImported = true
      return { autoUpdater }
    },
    "@admin/platform/desktop/contract": contract,
    "node:path": path.posix,
    "node:fs": {
      mkdirSync() {},
      writeFileSync: (p: string, data: string) => {
        written[p] = data
      },
      rmSync: (p: string) => removed.push(p),
    },
    "./config": { readConfig: () => ({ autoLaunch, kiosk: false, updateUrl: "", serverUrl: "", ...config }) },
    "./devices/card-reader": { CardReaderAdapter: class {} },
    "./devices/registry": { registerDevice() {}, stopAllDevices: async () => {} },
    "./ipc": {
      registerIpc() {},
      broadcast: (_channel: string, payload: unknown) => events.push(payload),
    },
    "./protocol": { registerAppScheme() {}, registerAppProtocolHandler() {} },
    "./window": { createMainWindow() {}, DEV_SERVER_URL: undefined },
  }
  const globals = {
    process: {
      platform,
      execPath: "/tmp/.mount_abc/admin-desktop",
      env: appImage ? { APPIMAGE: appImage } : {},
    },
    console: {
      info() {},
      log() {},
      warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
    },
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms, repeat: false }),
    setInterval: (fn: () => void, ms: number) => timers.push({ fn, ms, repeat: true }),
    clearInterval() {},
    clearTimeout() {},
  }
  makeLoader(mocks, globals)(path.resolve(import.meta.dirname, "../src/main/index.ts"))
  await flush()

  /** 把当前登记的定时器全部触发一轮（模拟时间走过去） */
  async function tick() {
    const pending = timers.splice(0)
    for (const t of pending) {
      t.fn()
      if (t.repeat) timers.push(t)
    }
    await flush()
  }
  return {
    loginItems,
    timers,
    warnings,
    events,
    written,
    removed,
    tick,
    /** 模拟 electron-updater 发一条事件（比如 AppImage 装完换了文件名） */
    emitUpdater: (event: string, arg?: unknown) => listeners[event]?.forEach((fn) => fn(arg)),
    get checks() {
      return checks
    },
    get updaterImported() {
      return updaterImported
    },
  }
}

// ── 开机自启 ────────────────────────────────────────────────────────────────

test("开机自启改回 false：启动时撤销系统登录项，而不是什么都不做", async () => {
  for (const platform of ["win32", "darwin"]) {
    const r = await boot({ platform, autoLaunch: false })
    assert.deepEqual(
      r.loginItems.map((s) => s.openAtLogin),
      [false],
      `${platform}：autoLaunch=false 时没调 setLoginItemSettings({ openAtLogin: false })，上次开过的登录项一直留着`
    )
  }
})

test("开机自启 true：注册登录项", async () => {
  const r = await boot({ platform: "win32", autoLaunch: true })
  assert.deepEqual(
    r.loginItems.map((s) => s.openAtLogin),
    [true]
  )
})

test("未打包（开发模式）不碰系统登录项 —— 否则登记的是 node_modules 里那个 electron", async () => {
  const r = await boot({ packaged: false, autoLaunch: true })
  assert.equal(r.loginItems.length, 0)
  const off = await boot({ packaged: false, autoLaunch: false })
  assert.equal(off.loginItems.length, 0)
})

test("Linux 没有 setLoginItemSettings：写 / 删 XDG autostart 的 .desktop", async () => {
  const on = await boot({ platform: "linux", autoLaunch: true, appImage: "/opt/apps/admin-desktop-1.2.3-x86_64.AppImage" })
  assert.equal(on.loginItems.length, 0)
  const file = "/home/u/.config/autostart/admin-desktop.desktop"
  assert.ok(on.written[file], `没写 ${file}`)
  // AppImage 运行时 execPath 是临时挂载点，重启后就没了；要登记 APPIMAGE 指向的那个文件
  assert.match(on.written[file], /^Exec="\/opt\/apps\/admin-desktop-1\.2\.3-x86_64\.AppImage"$/m)
  assert.match(on.written[file], /^\[Desktop Entry\]$/m)

  const off = await boot({ platform: "linux", autoLaunch: false })
  assert.deepEqual(off.removed, [file])
  assert.deepEqual(off.written, {})
})

test("Linux Exec 按 desktop entry 规范转义：先按引号规则、再按字符串规则，% 写成 %%", async () => {
  // 只转一层的话 GLib 读到 `\"` 是非法的字符串转义、整条值读不出来；`%/` 会被当成未知字段码
  const r = await boot({ platform: "linux", autoLaunch: true, appImage: String.raw`/opt/100%/a\b "x" $y.AppImage` })
  const entry = r.written["/home/u/.config/autostart/admin-desktop.desktop"]!
  const exec = entry.split("\n").find((l) => l.startsWith("Exec="))
  assert.equal(exec, String.raw`Exec="/opt/100%%/a\\\\b \\"x\\" \\$y.AppImage"`)
})

test('config.json 里手改出的非布尔 autoLaunch（"false"）不能被当成 true', async () => {
  const linux = await boot({ platform: "linux", config: { autoLaunch: "false" }, appImage: "/opt/a.AppImage" })
  assert.deepEqual(linux.written, {}, '字符串 "false" 是 truthy，原来会写出 autostart 文件')
  assert.equal(linux.removed.length, 1)
  const win = await boot({ platform: "win32", config: { autoLaunch: "false" } })
  assert.deepEqual(
    win.loginItems.map((s) => s.openAtLogin),
    [false]
  )
})

test("AppImage 自动更新换了文件名：autostart 的 Exec 跟着改，否则下次开机指向一个已删掉的文件", async () => {
  const file = "/home/u/.config/autostart/admin-desktop.desktop"
  const r = await boot({ platform: "linux", autoLaunch: true, appImage: "/opt/apps/admin-desktop-1.2.3-x86_64.AppImage" })
  await r.tick() // 第一次检查时才接上 electron-updater 的事件
  r.emitUpdater("appimage-filename-updated", "/opt/apps/admin-desktop-1.3.0-x86_64.AppImage")
  assert.match(r.written[file]!, /^Exec="\/opt\/apps\/admin-desktop-1\.3\.0-x86_64\.AppImage"$/m)

  const off = await boot({ platform: "linux", autoLaunch: false, appImage: "/opt/apps/admin-desktop-1.2.3-x86_64.AppImage" })
  await off.tick()
  off.emitUpdater("appimage-filename-updated", "/opt/apps/admin-desktop-1.3.0-x86_64.AppImage")
  assert.deepEqual(off.written, {}, "关着开机自启时不能因为换名把它写回来")
})

// ── 自动更新 ────────────────────────────────────────────────────────────────

test("打包后主进程自己定时检查更新：启动后延迟一次，之后周期检查", async () => {
  const r = await boot({ platform: "win32" })
  assert.equal(r.checks, 0, "启动当下就查会和首屏抢网络")
  assert.ok(r.timers.length > 0, "主进程没有安排任何更新检查 —— 渲染层也不调 updater.check()，自动更新永远不会发生")
  await r.tick()
  assert.equal(r.checks, 1)
  await r.tick()
  assert.equal(r.checks, 2, "只查一次的话，长期不关机的终端机永远停在启动那天的版本")
  // 事件照样广播给渲染层（「检查更新」那一屏和自动检查共用一条事件流）
  assert.ok(r.events.length > 0)
})

test("检查失败只记日志、不崩，下一轮照查（硬纪律 9：失败要留下痕迹）", async () => {
  const r = await boot({ platform: "linux", checkFails: true })
  await r.tick()
  assert.equal(r.checks, 1)
  assert.ok(
    r.warnings.some((w) => w.includes("ERR_NAME_NOT_RESOLVED")),
    `失败没进日志：${JSON.stringify(r.warnings)}`
  )
  assert.ok(r.events.some((e) => (e as { kind: string }).kind === "error"))
  // electron-updater 失败时既发 error 事件又 reject：两条路都记的话每次失败日志 / 事件各两条
  assert.equal(r.warnings.filter((w) => w.includes("ERR_NAME_NOT_RESOLVED")).length, 1, JSON.stringify(r.warnings))
  assert.equal(r.events.filter((e) => (e as { kind: string }).kind === "error").length, 1)
  await r.tick()
  assert.equal(r.checks, 2)
})

test("config.json 的 autoUpdate: false 关掉定时检查（下游项目 / 要钉版本的现场需要一个开关）", async () => {
  const r = await boot({ platform: "win32", config: { autoUpdate: false } })
  await r.tick()
  await r.tick()
  assert.equal(r.checks, 0)
  // 没写这个键的老 config.json 照旧自动检查
  const legacy = await boot({ platform: "win32" })
  await legacy.tick()
  assert.equal(legacy.checks, 1)
})

test("开发模式 / 未打包：不安排检查、不加载 electron-updater", async () => {
  const r = await boot({ packaged: false })
  await r.tick()
  await r.tick()
  assert.equal(r.checks, 0)
  assert.equal(r.updaterImported, false)
})

test("macOS 不自动检查：未签名的包下完也装不上，定时检查只会反复下一百多 MB 再失败", async () => {
  const r = await boot({ platform: "darwin" })
  await r.tick()
  await r.tick()
  assert.equal(r.checks, 0)
})

// ── 设置里改了开机自启：当场同步，不等下次启动 ──────────────────────────────

function loadIpc(initialAutoLaunch: boolean) {
  const handlers: Record<string, (event: unknown, ...args: unknown[]) => unknown> = {}
  let current = { serverUrl: "https://a.example.com", autoLaunch: initialAutoLaunch, kiosk: false }
  const synced: boolean[] = []
  const load = makeLoader(
    {
      electron: {
        BrowserWindow: { getAllWindows: () => [] },
        ipcMain: {
          handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
            handlers[channel] = fn
          },
          on() {},
        },
      },
      "@admin/platform/desktop/contract": contract,
      "./auth": { clearRefreshToken() {} },
      "./config": {
        readConfig: () => current,
        writeConfig: (patch: Record<string, unknown>) => {
          current = { ...current, ...patch }
          return current
        },
      },
      "./devices/registry": { onDeviceEvent() {} },
      "./login-item": { syncLoginItem: (enabled: boolean) => synced.push(enabled) },
      "./print": {},
      "./updater": {},
    },
    {}
  )
  const ipc = load(path.resolve(import.meta.dirname, "../src/main/ipc.ts")) as {
    registerIpc: (info: () => unknown) => void
  }
  ipc.registerIpc(() => ({}))
  return { set: (patch: Record<string, unknown>) => handlers[contract.IPC.configSet]!({}, patch), synced }
}

test("config:set 改了 autoLaunch 就同步系统登录项；没改不动", () => {
  const r = loadIpc(true)
  r.set({ kiosk: true })
  assert.deepEqual(r.synced, [])
  r.set({ autoLaunch: false })
  assert.deepEqual(r.synced, [false], "关掉开机自启后系统登录项还在，要等下次启动才撤销（若还有下次）")
  r.set({ autoLaunch: false })
  assert.deepEqual(r.synced, [false])
  r.set({ autoLaunch: true })
  assert.deepEqual(r.synced, [false, true])
})
