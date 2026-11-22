import * as React from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Text } from '@/components/ui/text'

/**
 * 用户头像：有图出图，没图出首字。全 App 只有这一份 —— 原来四个屏各写一遍，
 * 尺寸和圆角各不相同。
 *
 * 形状是圆角方块（squircle），圆角 ≈ 边长的 0.3，跟 iOS 应用图标的比例走。
 *
 * 🔴 **首字底色是主色的浅底 + 主色字，不是实心主色块。** 实心那版一屏十个
 * 一模一样的靛蓝方块，是全屏最重的东西，压过了名字本身；浅底保留「品牌陈述」
 * （分册「主色只能出现在这几处」里头像底那一条），但退到名字后面。
 *
 * ⚠️ 头像地址坏掉时 `AvatarImage` 静默不显示，`AvatarFallback` 兜住 —— 所以两个都要挂。
 *
 * `testID` 给 E2E 用（#381）：图片**真的加载出来之后**才是 `<testID>-loaded`，
 * 加载中是 `<testID>-image`，出首字时是 `<testID>-fallback`。只看「地址换了」不够 ——
 * 地址换成一张裂图（比如私有文件的下载地址），首字照样兜着，屏上看不出坏了。
 */
export function UserAvatar({
  name,
  src,
  size = 44,
  testID,
}: {
  name: string
  src?: string | null
  size?: number
  testID?: string
}) {
  const radius = Math.round(size * 0.3)
  const initial = (name.trim().slice(0, 1) || '?').toUpperCase()
  // 按地址记「加载成功」：换了地址就回到未加载，不会拿上一张图的状态冒充新图
  const [loadedSrc, setLoadedSrc] = React.useState<string | null>(null)
  const loaded = !!src && loadedSrc === src
  /*
   * ⚠️ `source` 要按地址记住：原语的 layout effect 依赖 `[props.source]`，每次换新对象都会先置 `error`
   * 再置 `loading`（读 `@rn-primitives/avatar` 源码）。上面的 `setLoadedSrc` 正好在 `onLoad` 之后多触发一次
   * 渲染 → 原语从 `loaded` 退回 `loading`；地址坏掉时父屏每敲一个字都会重挂 `<Image>` 再请求一遍、首字闪一下
   */
  const source = React.useMemo(() => (src ? { uri: src } : undefined), [src])
  return (
    <Avatar alt={name} style={{ width: size, height: size, borderRadius: radius }} testID={testID}>
      {src && source ? (
        <AvatarImage
          // 🔴 `key` 不能省：原语里 `onLoadingStatusChange` 被 `useCallback` 按 `onLoad` 缓存住，
          // 地址变了而组件不重挂的话，回调里的 `src` 还是上一张的（读源码得出，没单独验过）
          key={src}
          source={source}
          onLoadingStatusChange={(s) => setLoadedSrc(s === 'loaded' ? src : null)}
          testID={testID ? `${testID}-${loaded ? 'loaded' : 'image'}` : undefined}
        />
      ) : null}
      <AvatarFallback className="bg-primary/10" style={{ borderRadius: radius }} testID={testID ? `${testID}-fallback` : undefined}>
        <Text className="text-primary font-semibold" style={{ fontSize: Math.round(size * 0.4) }}>
          {initial}
        </Text>
      </AvatarFallback>
    </Avatar>
  )
}
