import { describe, expect, it, vi } from "vitest"

import type { DesktopBridge, UpdaterEvent } from "../desktop/contract"
import { watchDesktopUpdates } from "./desktop-update"

/** 一个假的 `desktop.updater`：`emit` 模拟主进程推事件 */
function fakeUpdater(opts: { downloaded?: string | null; install?: () => Promise<void> } = {}) {
  const handlers = new Set<(e: UpdaterEvent) => void>()
  const updater: DesktopBridge["updater"] = {
    check: async () => {},
    quitAndInstall: vi.fn(opts.install ?? (async () => {})),
    downloaded: vi.fn(async () => opts.downloaded ?? null),
    on: (handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
  return { updater, emit: (e: UpdaterEvent) => handlers.forEach((h) => h(e)), handlers }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("桌面端「已下载，重启更新」（#437）", () => {
  it("收到 downloaded 事件就提示，点「重启更新」调 quitAndInstall", async () => {
    const { updater, emit } = fakeUpdater()
    const ready = vi.fn()
    watchDesktopUpdates(updater, { ready, failed: vi.fn() })
    emit({ kind: "progress", percent: 50 })
    expect(ready).not.toHaveBeenCalled()
    emit({ kind: "downloaded", version: "1.2.0" })
    expect(ready).toHaveBeenCalledWith("1.2.0", expect.any(Function))
    ready.mock.calls[0][1]()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it("事件早就发过了（渲染层后挂上 / 整页重载）：挂上时补问一次主进程", async () => {
    const { updater } = fakeUpdater({ downloaded: "1.2.0" })
    const ready = vi.fn()
    watchDesktopUpdates(updater, { ready, failed: vi.fn() })
    await flush()
    expect(ready).toHaveBeenCalledWith("1.2.0", expect.any(Function))
  })

  it("🔴 重启更新失败要说出来、能重试（硬纪律 9），不是点了没反应", async () => {
    const install = vi.fn().mockRejectedValueOnce(new Error("更新器不可用")).mockResolvedValue(undefined)
    const { updater, emit } = fakeUpdater({ install })
    const ready = vi.fn()
    const failed = vi.fn()
    watchDesktopUpdates(updater, { ready, failed })
    emit({ kind: "downloaded", version: "1.2.0" })
    ready.mock.calls[0][1]()
    await flush()
    expect(failed).toHaveBeenCalledWith("更新器不可用", expect.any(Function))
    failed.mock.calls[0][1]()
    expect(install).toHaveBeenCalledTimes(2)
  })

  it("卸载后退订，不再提示", async () => {
    const { updater, emit, handlers } = fakeUpdater({ downloaded: "1.2.0" })
    const ready = vi.fn()
    const stop = watchDesktopUpdates(updater, { ready, failed: vi.fn() })
    stop()
    await flush()
    emit({ kind: "downloaded", version: "1.3.0" })
    expect(ready).not.toHaveBeenCalled()
    expect(handlers.size).toBe(0)
  })
})
