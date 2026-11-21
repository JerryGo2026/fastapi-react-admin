/**
 * 服务器地址的校验 + 规范化（#406）：合格返回**末尾不带斜杠**的基址，不合格返回 null。
 *
 * 判据和桌面端 `packages/platform/src/desktop/http-url.ts` 的 `serverBaseUrl` 一致（#392）——
 * 移动端不依赖 `platform`（根 CLAUDE.md「结构」），所以这里另写一份，改一处要对一下另一处：
 *
 * - 只收 http / https，主机不能空
 * - 拒绝查询串、片段、账号密码：请求按 `${base}/api/v1/...` 拼，`https://h/?env=prod` 会拼成
 *   `https://h/?env=prod/api/v1/...`，打到站点根、拿回 HTML；`user:pw@` 也拼不出一个能用的请求
 * - 拒绝空白、控制字符、反斜杠
 * - 路径前缀（反代子路径）保留，scheme 和主机转小写
 *
 * ⚠️ 刻意不用 `new URL()`：RN 自带的 URL 实现历史上 `hostname` / `search` 这些 getter 直接抛「not implemented」，
 * 换 Hermes / Expo 版本时行为会变，而这一步决定的是「能不能存」，不押在 polyfill 上
 */
export function serverBaseUrl(raw: string): string | null {
  const value = raw.trim()
  if ([...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127 || c === '\\')) return null
  if (/[?#]/.test(value)) return null
  const m = /^(https?):\/\/([^/]*)(\/.*)?$/i.exec(value)
  if (!m) return null
  const scheme = m[1].toLowerCase()
  const authority = m[2].toLowerCase()
  const path = (m[3] ?? '').replace(/\/+$/, '')
  /*
   * 主机 + 可选端口；IPv6 字面量要带方括号。`@`（账号密码）只在这一段里挡，路径里的 `@` 合法。
   * 🔴 标签字符**宽松**（评审跟进）：只排除分隔符 / 方括号 / `%` / `@`，下划线（内网 `fba_api`）、
   * 非 ASCII（IDN，OkHttp 自己转 punycode）、结尾点（FQDN）都收 —— 桌面端 `new URL` 也收，
   * 原来的 `/^https?:\/\/[^\s/]+/` 也收，收紧成 `[a-z0-9-]` 会让已经在用的地址存不进去
   */
  const hp = /^(\[[0-9a-f:.]+\]|[^.:[\]%@]+(\.[^.:[\]%@]+)*\.?)(:(\d{1,5}))?$/u.exec(authority)
  if (!hp) return null
  if (hp[4] !== undefined && (Number(hp[4]) < 1 || Number(hp[4]) > 65535)) return null
  if (path.startsWith('//')) return null
  return `${scheme}://${authority}${path}`
}

/**
 * 基址里的主机（小写，不带协议、端口、路径）。cookie jar 按**主机**分、不看端口和协议（RFC 6265），
 * 所以「旧服务器的登出响应会不会清掉新服务器的 refresh cookie」要按它比，不能按整个基址比（`lib/revoke.ts`）
 */
export function hostOf(base: string): string {
  const authority = base.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].toLowerCase()
  const at = authority.lastIndexOf('@')
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority
  if (hostPort.startsWith('[')) return hostPort.slice(0, hostPort.indexOf(']') + 1)
  return hostPort.replace(/:\d*$/, '').replace(/\.$/, '')
}
