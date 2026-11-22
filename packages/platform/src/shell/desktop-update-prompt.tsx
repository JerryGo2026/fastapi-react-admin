import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { toast } from '@admin/ui/components/toast'

import { tryDesktop } from '../desktop'
import { watchDesktopUpdates } from './desktop-update'

/**
 * 桌面端下载好更新后弹一条不自动消失的提示，带「重启更新」（#437）。浏览器里什么都不渲染。
 *
 * 挂在 app 根上（`apps/web/src/app.tsx`）而不是登录后的外壳里：终端机常停在登录页，那里也要看得到。
 * 同一时刻只留一条：主进程每 4 小时查一次，同一个版本会再发 `downloaded`，叠起来是噪音。
 */
export function DesktopUpdatePrompt() {
  const { t } = useTranslation()

  useEffect(() => {
    const bridge = tryDesktop()
    if (!bridge) return
    let current: string | undefined
    const replace = (id: string) => {
      if (current) toast.dismiss(current)
      current = id
    }
    const stop = watchDesktopUpdates(bridge.updater, {
      ready: (version, restart) =>
        replace(
          toast.info(t('新版本 {{version}} 已下载', { version }), {
            description: t('重启应用即可完成更新'),
            timeout: 0,
            action: { label: t('重启更新'), onClick: restart },
          })
        ),
      failed: (message, retry) =>
        replace(
          toast.error(t('重启更新失败'), {
            description: message,
            action: { label: t('重试'), onClick: retry },
          })
        ),
    })
    return () => {
      stop()
      if (current) toast.dismiss(current)
    }
  }, [t])

  return null
}
