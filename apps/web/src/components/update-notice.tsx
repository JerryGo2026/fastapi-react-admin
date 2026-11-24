import { useTranslation } from "react-i18next"
import { IconArrowRight, IconRefresh } from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { ToastDescription, ToastTitle } from "@admin/ui/components/toast"

import {
  MORTISE_OUTLINE,
  TENON_OUTLINE,
  type Outline,
} from "@/components/tenon-outline"

const toPath = (pts: Outline) =>
  `M${pts.map(([x, y]) => `${x} ${y}`).join(" L")} Z`

/**
 * 「服务端发新版了」那张卡片（#444）。检测在 `lib/app-version.ts`，这里只管长相。
 *
 * 原来复用的是 `toast.warning`：琥珀色三角读起来像「出错了」，唯一要点的「刷新」
 * 是一行小号文字链接。发版是好事，所以换成品牌色：榫头滑进卯眼 = 新的一片咬合上来。
 *
 * 由 `lib/app-version.ts` 的 `showUpdateNotice` 经 `toast.custom` 弹出 —— 走 toast 的视口，
 * 不另起一个 fixed 浮层：右上角同时弹的别的 toast 会和它排队，而不是撞在同一个角上。
 */
export function UpdateNotice({
  versions,
  onLater,
}: {
  versions: { current: string; next: string } | null
  onLater: () => void
}) {
  const { t } = useTranslation()

  return (
    <div
      data-testid="update-notice"
      className="relative overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
    >
      <style href="update-notice" precedence="medium">
        {CSS}
      </style>
      {/* 顶边一道品牌色，和登录页标题里那两个字的流光同一组色 */}
      <div
        aria-hidden
        className="update-notice-rail absolute inset-x-0 top-0 h-0.5"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -end-14 -top-16 size-40 rounded-full bg-primary/12 blur-3xl"
      />

      <div className="relative flex gap-3.5 p-4">
        <div
          aria-hidden
          className="update-notice-tile grid size-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-6"
            fill="currentColor"
            focusable="false"
          >
            <path className="update-notice-tenon" d={toPath(TENON_OUTLINE)} />
            <path d={toPath(MORTISE_OUTLINE)} fillOpacity="0.5" />
          </svg>
        </div>

        <div className="min-w-0 flex-1">
          <p
            aria-hidden
            className="font-mono text-[10px] leading-none tracking-[0.3em] text-primary uppercase"
          >
            Update
          </p>
          <ToastTitle className="mt-1.5 text-sm leading-snug font-semibold">
            {t("新版本已就绪")}
          </ToastTitle>

          {versions && (
            <div
              data-testid="update-notice-versions"
              className="mt-1.5 flex items-center gap-1.5 font-mono text-xs"
            >
              <span className="text-muted-foreground">{versions.current}</span>
              <IconArrowRight
                aria-hidden
                className="size-3 text-muted-foreground/70"
              />
              <span className="rounded-sm bg-primary/10 px-1.5 py-px font-medium text-primary">
                {versions.next}
              </span>
            </div>
          )}

          <ToastDescription className="mt-2 text-[13px] leading-relaxed text-pretty text-muted-foreground">
            {t("未保存的内容请先保存，再刷新。")}
          </ToastDescription>

          <div className="mt-3.5 flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => window.location.reload()}
              data-testid="update-notice-reload"
            >
              <IconRefresh data-icon="inline-start" />
              {t("立即刷新")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onLater}
              data-testid="update-notice-later"
            >
              {t("稍后")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 榫头从左边滑进卯眼、咬合时整块轻轻一顿 —— 只在出现时演一次，不循环（常驻的卡片一直动是干扰）。
 * 颜色全走 `--primary`：主题色偏好换成什么，这张卡片跟着换。
 */
const CSS = `
.update-notice-rail {
  background: linear-gradient(90deg, var(--primary) 0%, color-mix(in oklch, var(--primary) 55%, oklch(0.7 0.2 350)) 60%, transparent 100%);
}
.update-notice-tenon {
  transform-box: fill-box;
  animation: update-notice-slide .7s cubic-bezier(.3,.7,.2,1) .25s both;
}
.update-notice-tile { animation: update-notice-seat .35s ease-out .9s both }
@keyframes update-notice-slide { from { transform: translateX(-45%); opacity: .2 } to { transform: none; opacity: 1 } }
@keyframes update-notice-seat { 0% { transform: none } 40% { transform: scale(.92) } 100% { transform: none } }
@media (prefers-reduced-motion: reduce) {
  .update-notice-tenon, .update-notice-tile { animation: none }
}
`
