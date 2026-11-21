/** 探测的超时。连不上的地址 RN 的 fetch 自己要等 10～60 秒，按钮一直转着像卡死；Hermes 没有 `AbortSignal.timeout()` */
export const PROBE_TIMEOUT_MS = 10_000

export type ProbeFailure =
  | { kind: 'cancelled' }
  | { kind: 'timeout' }
  | { kind: 'http'; status: number }
  | { kind: 'not-fba' }
  | { kind: 'network'; message: string }

type ProbeResponse = { ok: boolean; status: number; json: () => Promise<unknown> }

/**
 * 先探一下这个地址是不是本项目的后端，通了再换服务器（#406）。成功返回 null，失败返回原因（文案由调用方翻）。
 *
 * 打 `/api/v1/auth/captcha`：无需鉴权、一定存在，FBA 的响应都带 `code`。
 *
 * 🔴 **`cancel` 一断就绝不换服务器**（评审跟进）：用户点了「取消」、或者表单卸载了（离开设置屏），
 * 原来探测照样跑完、通了就 `switchServer` —— 屏上显示的还是旧地址，存进去的已经是新的、旧会话也被登出了。
 * 所以「探测返回」和「真去换」之间每一步都要再看一眼 `cancel`。
 */
export async function probeThenSwitch(
  base: string,
  deps: {
    fetch: (url: string, init: { method: 'GET'; signal: AbortSignal }) => Promise<ProbeResponse>
    switchServer: () => Promise<void>
    cancel: AbortSignal
    timeoutMs?: number
  },
): Promise<ProbeFailure | null> {
  const { cancel } = deps
  if (cancel.aborted) return { kind: 'cancelled' }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, deps.timeoutMs ?? PROBE_TIMEOUT_MS)
  const onCancel = () => controller.abort()
  cancel.addEventListener('abort', onCancel)
  try {
    let res: ProbeResponse
    try {
      res = await deps.fetch(`${base}/api/v1/auth/captcha`, { method: 'GET', signal: controller.signal })
    } catch (err) {
      if (cancel.aborted) return { kind: 'cancelled' }
      if (timedOut) return { kind: 'timeout' }
      const message = (err as { message?: unknown } | null)?.message
      return { kind: 'network', message: typeof message === 'string' ? message : String(err) }
    }
    if (cancel.aborted) return { kind: 'cancelled' }
    if (!res.ok) return { kind: 'http', status: res.status }
    const body = (await res.json().catch(() => null)) as { code?: unknown } | null
    if (cancel.aborted) return { kind: 'cancelled' }
    // FBA 的所有响应都带 code；不带说明这不是本项目的后端
    if (typeof body?.code !== 'number') return { kind: 'not-fba' }
    await deps.switchServer()
    return null
  } finally {
    clearTimeout(timer)
    cancel.removeEventListener('abort', onCancel)
  }
}
