/**
 * 桌面端「已下载，重启更新」（#437）。
 *
 * 主进程定时检查并下载更新（#428），但只在**退出时**装（`autoInstallOnAppQuit`）——
 * 长期不关的终端机会一直停在旧版。这里订阅 `downloaded` 事件给出「重启更新」入口。
 *
 * - 事件可能早就发过了（渲染层挂上监听之前下完的、整页重载过）：挂上时补问一次 `downloaded()`
 * - 重启失败（更新器不可用）要说出来并能重试（硬纪律 9），不是点了没反应
 *
 * 纯逻辑放这里（能测），弹什么样的提示由 `desktop-update-prompt.tsx` 决定。
 */
import type { DesktopBridge } from '../desktop/contract'

export interface UpdatePrompt {
  /** 有一个下载好的版本等着装 */
  ready(version: string, restart: () => void): void
  /** 点了「重启更新」但没成 */
  failed(message: string, retry: () => void): void
}

/** 返回退订函数 */
export function watchDesktopUpdates(updater: DesktopBridge['updater'], prompt: UpdatePrompt): () => void {
  let alive = true
  const restart = () => {
    updater.quitAndInstall().catch((e: unknown) => {
      if (alive) prompt.failed(e instanceof Error ? e.message : String(e), restart)
    })
  }
  const show = (version: string) => {
    if (alive) prompt.ready(version, restart)
  }
  const unsubscribe = updater.on((event) => {
    if (event.kind === 'downloaded') show(event.version)
  })
  updater
    .downloaded()
    .then((version) => {
      if (version) show(version)
    })
    // 补问失败不致命：之后的 downloaded 事件照样会到（主进程每 4 小时查一次）
    .catch((e: unknown) => console.warn('[desktop] 查询已下载的更新失败', e))
  return () => {
    alive = false
    unsubscribe()
  }
}
