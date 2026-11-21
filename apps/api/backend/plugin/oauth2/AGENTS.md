# plugin/oauth2 —— 第三方登录（GitHub / Google）

> 应用级插件，回调在 `/api/v1/oauth2/{github,google}/callback`（免鉴权）。配置项见同目录 `README.md`。
> 「设 cookie 再重定向」那个坑记在 [`apps/api` 分册](../../../AGENTS.md)。
>
> 这份文件是 [`apps/api` 分册](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

## 🔴 陌生账号默认不建号（#226）

`plugin/oauth2` 原来对「库里对不上任何用户」的社交账号**无条件自动建号**：`is_staff=True`，角色取
`select(Role).where(启用)...first()` —— 没有 `ORDER BY`，挂到哪个角色取决于数据库物理行序。
插件默认启用、回调在免鉴权名单里，所以任何一个 GitHub / Google 账号走一遍就成了系统用户。

现在 `OAUTH2_AUTO_REGISTER` 默认 `False`（陌生账号 403、不建号）；打开时必须配 `OAUTH2_AUTO_REGISTER_ROLE`
（`sys_role.code`），找不到 / 停用就拒绝，**不退回别的角色**。绑定还在、用户被逻辑删除时也是 403，原来是 500。

⚠️ 写这类「两道检查前后挨着」的测试，要让**只有被测那一道**能拦住：第一版「开关关着要拒绝」那条没配角色，
去掉开关后紧接着的「角色未配置」也抛同一种异常，**变异检验照样全绿**。

**实测证据**：`plugin/oauth2/tests/test_auto_register.py` 5 条；三处变异（去掉开关 · 角色退回 `.first()` · 去掉删除用户的判空）各自当场红。

## 🔴 按邮箱关联已有用户，只认第三方验证过的邮箱（#227）

社交账号第一次进来、邮箱和某个已有用户相同，就把它绑到那个用户上并登录 —— 等于「谁能让 GitHub / Google
返回这个邮箱，谁就能登进那个账号」。原来没有任何验证判断，`fastapi_oauth20` 的 GitHub 客户端取不到 primary
时还会回落到 `emails[0]`。现在回调算出 `email_verified` 往下传（`utils.py`）：Google 看 `verified_email` /
`email_verified`，GitHub 自己再查一次 `/user/emails`，**同一个地址**且 `verified: true` 才算；查失败当没验证。
没验证的邮箱既不拿来关联，也不写进自动注册的新用户（否则真主人来关联时撞上的是陌生人建的号）。

⚠️ **会话工厂是 `autoflush=False`**（`database/db.py`）：`create_model` 只 `add` 不 `flush`，紧接着
`select` 查不到。第一版「没验证就不该有绑定行」那条断言因此**永远成立**；对照组（验证过的应该有）反而红了才暴露。
断言「有 / 没有某一行」之前先 `await db.flush()`。

⚠️ 关联之后是开会话（要真 request / cookie / 全局 Redis 客户端），pytest 里全局 Redis 绑在别的事件循环上会
`attached to a different loop`。测「关联到了谁」时把关联之后的
第一步（`password_security_service.peek_lock_reason`）打桩成抛哨兵异常，异常里带上 user_id。

**实测证据**：`tests/test_verified_email.py` 13 条；变异 —— 去掉「没验证就不关联」→ 反面用例红；GitHub 判定
不看 `verified` → 两组参数红。⚠️ 第一次做第二个变异时 sed 没匹配上（ruff format 把那几行并成了一行），
测试「全绿」是因为代码根本没变 —— 变异之后先 `grep` 确认改动真的落了。

## 🔴 state 绑在发起授权的浏览器上：cookie 在后端 authorize 那一跳下发（#227 后半）

**症状**（修之前）：攻击者自己走一遍授权，把带着**自己** `code` + `state` 的回调地址发给受害者 → 受害者登进攻击者的账号，
之后上传的文件、填的数据都落进去（login CSRF）。state 只是 Redis 里的裸 UUID，回调只看「存在且没用过」。

**为什么不能在原来那个接口上设 cookie**：授权链接是前端 XHR 拿的，开发环境 `localhost:8888` → `127.0.0.1:8088` 是跨站
（`localhost` 和 `127.0.0.1` 不是同一个 site），桌面端 `app://local` 也是 —— 跨站 XHR 响应里的 `SameSite=Lax` cookie
浏览器**不保证**存下来、更不保证之后带上（推断，没在真浏览器里测过；同一类跨站问题让 refresh cookie 在桌面端走不通，
那条是实测过的，见 `packages/platform/src/api-client/client.ts`）。猜错的代价是全员第三方登录失效，所以不赌。

**修法**（`state_binding.py`）：`GET /oauth2/{github,google}` 和 `GET /oauth2/me/binding` 照旧返回一个字符串 URL，
但 URL 换成后端自己的 `GET /oauth2/{provider}/authorize` —— 顶层跳转，在这一跳上设 `fba_oauth2_state`
（HttpOnly · Lax · `Path=/api/v1/oauth2`）再 302 到第三方；回调的 `dependencies` 第一个就是 `require_state_cookie`，
对不上直接 403，**不去第三方换 token、不消耗 Redis 里的 state**。前端一行没改。

- ⚠️ **authorize 的地址从回调地址推出来**（`.../callback` → `.../authorize`），不要用 `request.url_for`：
  cookie 设在哪个 host，回调就必须打到哪个 host；反代后面 `url_for` 拿到的 host 可能和配置的回调地址不同，
  那样 cookie 永远带不回来，全员第三方登录 403
- ⚠️ **绑定还留着一个口子**：绑定 state 带 user_id，authorize 是顶层跳转、带不了 Bearer 头，核对不了登录态。
  现在绑定链接是**一次性 ticket**（第一个打开的浏览器认领），但攻击者把自己刚取到、还没打开的绑定链接
  在 3 分钟内骗受害者点开并授权，受害者的第三方账号仍会绑到攻击者名下。要堵死得让绑定入口能核对登录态
  （例如前端用表单 POST 把 access token 带过去）；桌面端怎么打开授权页没核实过，改之前先看那一边

**实测证据**：`tests/test_state_binding.py` 7 条（TestClient 真请求，换 token 那一步打桩成抛哨兵异常）；
三处变异 —— 回调去掉 `require_state_cookie` → 「没有 cookie」「别人的 state」两条红；认领不看 NX 结果 →
「ticket 只能用一次」红；authorize 不下发 cookie → 三条红。⚠️ **真浏览器 + 真 OAuth 应用还没跑过**：
顶层跳转能设 Lax cookie、回调能带上，是浏览器规范保证的行为，但这里没有亲眼看到过。

## 🔴 回调里的业务拒绝要 302 回前端，不能抛出去（v1.0.1 发版前评审）

**症状**：#226 之后，没绑定过的 GitHub / Google 账号第一次社交登录，浏览器停在 **API 域名**上一页裸 JSON
（`{"code":403,"msg":"这个 Github 账号还没有绑定系统用户…"}`），回不到前端、也没有返回入口。原来只有 state 出错这种边角路径才这样，
#226 把它变成了每个新用户的默认路径。

**根因**：回调是「第三方 → 后端」的顶层跳转，不是 XHR —— 异常走全局处理器渲染成 JSON，直接显示给人看。

**修法**：两个回调把 `login_or_binding` 包在 `try` 里，`errors.BaseExceptionError` 交给 `state_binding.callback_failed`：
302 到 `OAUTH2_FRONTEND_LOGIN_REDIRECT_URI?error=<文案>` 并清掉 state cookie；前端落地页 `routes/oauth2/callback.tsx` 显示原因。

- 🔴 **吞异常之前必须 `await db.rollback()`**：处理函数跑在依赖的 exit stack **里面**（fastapi 0.141 `routing.request_response`），
  异常被吞掉后 `CurrentSessionTransaction` 看到的是正常返回、照样 commit —— 抛错之前写了一半的东西会被提交
- ⚠️ 落地页**不能挂在 `_guest` 下面**：绑定失败也落到这里，发起绑定的人是已登录的，`_guest` 守卫会把他踢回工作台，错误被静默吞掉
- ⚠️ `dependencies` 里抛的（`require_state_cookie` 403、限流 429、换 token 失败）不经过这个 `try`，仍然是 JSON —— 那几条是攻击 / 异常路径，没改

**实测证据**：`tests/test_state_binding.py::test_rejected_login_goes_back_to_the_frontend_with_the_reason`（TestClient 真请求，
换 token / 拉用户信息打桩）；变异 —— github 回调的 `except` 改成 `except KeyboardInterrupt` → 当场红，响应体正是上面那页 403 JSON。
⚠️ 前端落地页的错误态只过了 typecheck / build，没在浏览器里点过。

## 🔴 第三方建的无密码账号：第一次设密码要重新走一遍已绑定的第三方授权（#402）

**症状**：`OAUTH2_AUTO_REGISTER` 建出来的号（`sys_user.password` 为 NULL）在个人中心改密码、超管在用户管理里重置密码，**都失败**；
超管那条回 422「password 输入应为有效的字符串，输入：None」—— 看着像前端没传密码，其实是后端在写密码历史。

**根因**：`user_service` 两处改密都在改完之后 `CreateUserPasswordHistoryParam(password=previous_password)`，无密码账号的旧值是 None，
schema 必填 `str` → ValidationError → 事务回滚。🔴 自助那条同时还**跳过了旧密码校验**（`if user.password and not password_verify(...)`），
一直是后面这个异常在兜底：只把 None 放过去，拿到这个人一枚 access token（30 分钟）的人就能给他设一个长期有效的密码。

**修法**：

- 历史记录只在有旧 hash 时写（两处）；超管重置不需要额外验证（超管本来就能重置任何人）
- 自助那条：无密码账号不验旧密码，改验 `app/admin/utils/password_set_grant.py` 里的凭据 —— 只有 `GET /oauth2/me/reauth` 发起、
  回调里**按 `sid` 查到的绑定正属于发起人**才写入（10 分钟），`update_password` 在复杂度等校验都过了之后才 `GETDEL` 消费（被拒不用重跑授权）。
  凭据放 admin 不放插件：消费方是 admin，admin 不能 import 插件；插件停用时无密码账号只能找超管重置
- 链接形状照抄绑定（一次性 ticket + authorize 那一跳下发 state cookie），回调落 `个人中心?section=security`（绑定也一起改了，
  原来落「资料」面板、第三方账号那块在「安全」里）。前端走**当前页**跳转，回来时 `GET /sys/users/me/password-status` 的
  `reauth_verified` 为 true，表单只要新密码
- 无密码账号**不能解绑最后一个第三方账号**：解了就再也登不进来、也没有东西能自证去设密码

⚠️ 留着的口子同绑定那条：攻击者用盗来的会话取 reauth 链接、骗受害者在已登录第三方的浏览器里点开，对方静默放行，
凭据就记在发起的会话（攻击者手里那个）上（评审跟进之前是记在用户名下）。比修之前（一个 token 直接设）窄，要堵死同样得让 authorize 能核对登录态。
⚠️ 开了 MFA 的无密码账号，重新授权这一步**不过 MFA**（`mfa_gate` 只在登录路径上），没做。

**实测证据**：`tests/test_passwordless_set_password.py` 9 条（TestClient 真请求，换 token / 拉用户信息打桩，第三方绑定也走真实绑定流程建出来）。
修之前 7 条红：状态接口 / reauth 接口 404、能解绑最后一个、超管重置 422（就是上面那句）。
变异各自当场红：去掉两道凭据检查 → 「只拿 token 设不了」「别的第三方账号不算」两条；先消费后校验 → 3 条；
回调不核对 `sid` 归属 → 「别的第三方账号不算」；去掉解绑保护 → 1 条；历史记录不判空 → 4 条。
⚠️ 单去掉 `is_granted` 或单去掉 `consume` 都**不红**：两道互为兜底（前者为了不白跑校验、后者为了原子），只有一起去掉才红。
前端：E2E `apps/web/e2e/tests/profile-first-password.spec.ts` 4 条（`page.route` 改写状态 / 绑定接口，PostgreSQL 私有库）——
没验证只给已绑定来源的按钮、没有「当前密码」框 · 一个都没绑说找管理员 · 验证过只要新密码、请求体不带 `old_password` · 状态 502 是错误 + 重试、
不退回要旧密码的表单。变异：密码块恒画「修改密码」→ 4 条全红。
⚠️ **真 OAuth 应用没跑过**（回调落地、当前页跳转回来之后状态刷新，都只靠后端 TestClient 测过）；桌面端 / 移动端没看。

### 评审跟进（#402 PR #431）

- 🔴 **凭据记在发起重新授权的那个会话上**（key 带 `session_uuid`，state 里也带着），不是记在用户上。按用户记时，
  拿着偷来 token 的另一个会话轮询 `password-status`，看到本人刚验证完就能抢先 PUT 一个只有自己知道的密码
- 🔴 **解绑先锁用户行再数**（`FOR UPDATE`，SQL Server 另给 `UPDLOCK, HOLDLOCK`）：不锁时同时解绑两个来源，两个事务都数到 2、
  各删各的那一行（不同行、互不阻塞），账号什么都不剩
- 已有密码的账号拿不到 reauth 链接（`reauth_not_needed`）
- 前端：设 / 改密码成功后**不能**作废 `passwordStatusQuery` —— 会话已被撤，重取 401 当场踢回登录页、看不到倒计时；
  提交失败时**要**重取，凭据过期了才能退回「先验证身份」，否则表单一直写着「身份已验证」、只能重复提交同一句拒绝

**实测证据**：`test_passwordless_set_password.py` 新增 3 条，修之前全红 —— 另一会话设上了密码（`code` 200）·
有密码照样拿到链接 · 并发解绑两条都成功、剩 0 行（结果 `[1, 1]`，测试里让两个事务都数完再往下走）。
E2E 新增 2 条，前端改动撤掉后两条都红（凭据过期那条找不到重新验证按钮 · 设完密码那条倒计时不见了）。

⚠️ ~~凭据在写库之前就 `GETDEL` 了~~ —— #437 修了，见下一节。

## 🔴 设密凭据写库成功之后才消费，并发照样只能用一次（#437）

**症状**：无密码账号重新授权回来、提交新密码时库抖了一下（写库报错 / 提交失败），凭据已经被消费，
页面退回「先验证身份」，用户要再跳一遍第三方授权。

**根因**：`update_password` 在写库**之前** `GETDEL`。GETDEL 换来了「两个并发请求只有一个拿得到」，代价是之后任何失败都把凭据烧掉。
直接挪到写库之后（看一眼还在 → 写 → 删）又开了并发窗口：两个请求都看到「还在」、都写进去。

**修法**（`app/admin/utils/password_set_grant.py` 的 `held()`，包住写密码那几句）：
另一把 key 上 `SET NX EX 30` **占位**（并发只有一个占得到，凭据本身不动）→ 写库 + `flush` →
里面抛错就比对 token 删占位（Lua）；**提交**那一步失败 service 里的 try 看不到，靠挂在会话最外层
`after_soft_rollback` 上的钩子派协程删占位；提交成功由后台任务（`CurrentSessionTransaction` 先提交、后台任务后跑、回滚不跑）
把凭据和占位一起删。占位回写都失败了最多卡 30 秒；提交成功后 `password` 已非 NULL，凭据那条分支走不到，`finish` 没跑成也用不了第二次。

- ⚠️ **钩子里不能 `sa_event.remove` 自己**：派发途中改监听列表 → `RuntimeError: deque mutated during iteration`
  （第一版就这么写的，「写库失败」那条当场 500），改成 `fired` 标记
- ⚠️ 单去掉 service 里的同步回写**不红**：写库报错也会走到会话回滚，钩子兜住了（两道互为兜底，前者同步、后者管提交失败）

**实测证据**（2026-11-22，PostgreSQL 私有库 + 一次性 Redis）：`test_passwordless_set_password.py` 新增 3 条 ——
「写库失败凭据还在」「提交失败凭据还在」修之前红（`reauth_verified` 变 false、重试被拒）；「并发两个只成一个」修之前绿（GETDEL 本来就原子），
是给「挪到写库之后」上的守卫：占位去掉 `nx=True` → 当场红（`assert 2 == 1`，两个都 200）。去掉回滚钩子 →「提交失败」那条红（「凭据一直卡在使用中」）。
oauth2 全部 49 条 + 会话撤销 / 用户快照 / i18n 共 64 条绿。

## 绑定 / 重新验证的落地地址用 URL 解析设参数（#437）

`profile_security_url()` 原来是 `base + ('&' if '?' in base else '?') + 'section=security'`：配置里已带 `section=info`
时拼出两个 `section`（前端读第一个，落错面板）；带 `#top` 时参数跑进 hash 后面、路由读不到。现在 `urlsplit` + `parse_qsl`
去掉同名参数再设；hash 路由形状（`#/profile`）把参数设进 hash 里。
**实测证据**：`test_profile_security_url_sets_the_section_by_parsing` 7 组，修之前 4 组红（`section=info` 两种 · `#top` 两种）。
