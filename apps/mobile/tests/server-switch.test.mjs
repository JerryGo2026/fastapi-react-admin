import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * #406：移动端换服务器。只测 `src/lib` 里的纯逻辑（Node 里跑，RN / SecureStore / fetch 全是桩）；
 * 「登录屏上有入口、未登录也进得去」那一半在 Maestro（`e2e/flows/server-from-login.yaml`）。
 *
 * 写法照 `apps/desktop/tests/server-url.test.ts`：TS 现场转成 CommonJS、在 vm 里跑，`require` 换成桩。
 * 用 `.mjs` 是因为 `apps/mobile/tsconfig.json` 会把 `**\/*.ts` 都拿去 typecheck，而这里没有 `@types/node`。
 */

function load(relative, imports, globals = {}) {
  const filename = path.resolve(import.meta.dirname, relative)
  const js = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  vm.runInNewContext(js, {
    exports,
    AbortController,
    ...globals,
    require: (name) => {
      assert.ok(name in imports, `没给桩：${name}`)
      return imports[name]
    },
  })
  return exports
}

// ── 地址校验 ──────────────────────────────────────────────────────────────

const serverUrl = load('../src/lib/server-url.ts', {})
const { serverBaseUrl } = serverUrl

test('合格的地址规范化成不带末尾斜杠的基址', () => {
  assert.equal(serverBaseUrl('  https://fra.example.com/  '), 'https://fra.example.com')
  assert.equal(serverBaseUrl('HTTPS://Fra.Example.com'), 'https://fra.example.com')
  assert.equal(serverBaseUrl('http://10.0.2.2:8001'), 'http://10.0.2.2:8001')
  // 反代子路径保留，大小写不动（路径区分大小写）
  assert.equal(serverBaseUrl('https://h.example.com/Admin//'), 'https://h.example.com/Admin')
  assert.equal(serverBaseUrl('http://[::1]:8088'), 'http://[::1]:8088')
})

test('拼不出请求的地址一律拒绝', () => {
  for (const bad of [
    '',
    'fra.example.com', // 没协议
    'ftp://fra.example.com',
    'https://',
    'https:///path',
    'https://h.example.com/?env=prod', // 查询串：`${base}/api/v1/...` 会拼成 `?env=prod/api/v1/...`
    'https://h.example.com/?',
    'https://h.example.com/#x',
    'https://user:pw@h.example.com', // 账号密码
    'https://h.example.com:99999',
    'https://h.example.com:abc',
    'https://h .example.com',
    'https://h.example.com\\evil',
    'https://h.example.com/\npath',
  ]) {
    assert.equal(serverBaseUrl(bad), null, JSON.stringify(bad))
  }
})

// ── 换服务器 / 登出撤销 ────────────────────────────────────────────────────

function harness(start = 'https://old.example.com') {
  let base = start
  const log = []
  const pending = new Set()
  let token = 'tok'
  const posts = []
  const mod = load(
    '../src/lib/revoke.ts',
    {
      '@admin/api': { confirmsLogout: (err) => err?.confirms === true },
      '@/lib/api': {
        api: {
          // 每次登出请求记下「发出那一刻的地址」，由测试决定它什么时候、怎样结束
          POST(p) {
            let settle
            const done = new Promise((resolve, reject) => (settle = { resolve, reject }))
            posts.push({ path: p, base, ...settle })
            log.push(`POST ${p} @ ${base}`)
            return done
          },
        },
      },
      '@/lib/logout-pending': {
        logoutPending: {
          has: (b) => pending.has(b),
          add: async (b) => void (pending.add(b), log.push(`pending+ ${b}`)),
          remove: async (b) => void (pending.delete(b), log.push(`pending- ${b}`)),
        },
      },
      '@/lib/server': {
        serverStore: {
          current: () => base,
          set: async (next) => void ((base = next ?? 'https://default.example.com'), log.push(`server ${base}`)),
        },
      },
      '@/lib/server-url': serverUrl, // 真模块：按主机比较就在它里面
      '@/lib/token-store': { tokenStore: { clear: async () => void ((token = null), log.push('token cleared')) } },
    },
    // 超时定时器不真排：挂着的请求不该让测试进程多等 8 秒
    { setTimeout: () => 0, clearTimeout: () => {} },
  )
  return { mod, log, pending, posts, token: () => token, base: () => base }
}

test('换服务器：先在旧服务器上记标记、清 token、发登出，再换地址', async () => {
  const h = harness()
  await h.mod.switchServer('https://new.example.com')
  assert.deepEqual(h.log, [
    'pending+ https://old.example.com',
    'token cleared',
    'POST /api/v1/auth/logout @ https://old.example.com',
    'server https://new.example.com',
  ])
  assert.equal(h.token(), null)
  // 旧服务器确认了登出 → 标记删掉；没确认就留着，以后切回去冷启动不静默恢复
  h.posts[0].resolve()
  await new Promise((r) => setImmediate(r))
  assert.equal(h.pending.has('https://old.example.com'), false)
})

test('换服务器：旧服务器连不上 → 标记留着', async () => {
  const h = harness()
  await h.mod.switchServer('https://new.example.com')
  h.posts[0].reject(new Error('Network request failed'))
  await new Promise((r) => setImmediate(r))
  assert.equal(h.pending.has('https://old.example.com'), true)
})

test('换了服务器之后登录，不等打向旧服务器的那次撤销', async () => {
  const h = harness()
  await h.mod.switchServer('https://new.example.com')
  // 旧服务器的登出请求一直挂着（连不上）。cookie jar 按主机分，它清不到新服务器的 cookie
  let settled = false
  void h.mod.settleRevoke().then(() => (settled = true))
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, true, '在新服务器上登录被旧服务器的撤销卡住了')
})

test('同一台服务器上登出后马上登录，仍要等撤销落地（#374 的竞态）', async () => {
  const h = harness()
  await h.mod.forgetServerCredentials()
  let settled = false
  void h.mod.settleRevoke().then(() => (settled = true))
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false)
  h.posts[0].resolve()
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, true)
})

// ── 评审跟进（#406） ──────────────────────────────────────────────────────

test('原来存得进去的合法地址照样收：下划线主机、结尾点、IDN、路径里的 @', () => {
  assert.equal(serverBaseUrl('http://fba_api:8088'), 'http://fba_api:8088')
  assert.equal(serverBaseUrl('https://h.example.com.'), 'https://h.example.com.')
  assert.equal(serverBaseUrl('https://例子.中国'), 'https://例子.中国')
  assert.equal(serverBaseUrl('https://h.example.com/@team'), 'https://h.example.com/@team')
  // 账号密码 / 空标签仍然拒
  assert.equal(serverBaseUrl('https://user@h.example.com'), null)
  assert.equal(serverBaseUrl('https://.example.com'), null)
  assert.equal(serverBaseUrl('https://h..example.com'), null)
})

test('同主机换端口：登录仍要等旧端口那次撤销（cookie 按主机分、不分端口）', async () => {
  const h = harness('http://192.168.1.10:8088')
  await h.mod.switchServer('http://192.168.1.10:8089')
  let settled = false
  void h.mod.settleRevoke().then(() => (settled = true))
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false, '旧端口的登出响应还会清掉新端口的 refresh cookie，必须等')
  h.posts[0].resolve()
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, true)
})

test('A→B→A 连换两次：回到 A 登录要等 A 的那次撤销，不能被 B 的覆盖掉', async () => {
  const h = harness('https://a.example.com')
  await h.mod.switchServer('https://b.example.com')
  await h.mod.switchServer('https://a.example.com')
  assert.equal(h.posts.length, 2)
  let settled = false
  void h.mod.settleRevoke().then(() => (settled = true))
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false)
  h.posts[1].resolve() // B 的落地了，A 的还挂着
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false)
  h.posts[0].resolve()
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, true)
})

// ── 探测 → 换服务器（`lib/server-probe.ts`） ──────────────────────────────

// vm 里造的对象原型不是本 realm 的，deepStrictEqual 会判不等
const plain = (v) => JSON.parse(JSON.stringify(v))

function probeHarness() {
  const calls = { switched: 0, fetches: [] }
  const mod = load('../src/lib/server-probe.ts', {}, { setTimeout: () => 0, clearTimeout: () => {} })
  const fetchImpl = (url, init) => {
    let settle
    const p = new Promise((resolve, reject) => (settle = { resolve, reject }))
    init.signal.addEventListener('abort', () => settle.reject(new Error('Aborted')))
    calls.fetches.push({ url, ...settle })
    return p
  }
  const run = (cancel) =>
    mod.probeThenSwitch('https://x.example.com', {
      fetch: fetchImpl,
      switchServer: async () => void calls.switched++,
      cancel: cancel.signal,
    })
  return { calls, run }
}

test('探测通过 → 换服务器', async () => {
  const h = probeHarness()
  const p = h.run(new AbortController())
  h.calls.fetches[0].resolve({ ok: true, status: 200, json: async () => ({ code: 200 }) })
  assert.equal(await p, null)
  assert.equal(h.calls.switched, 1)
  assert.equal(h.calls.fetches[0].url, 'https://x.example.com/api/v1/auth/captcha')
})

test('探测途中点了取消 / 表单卸载 → 不换服务器', async () => {
  const h = probeHarness()
  const cancel = new AbortController()
  const p = h.run(cancel)
  cancel.abort()
  assert.deepEqual(plain(await p), { kind: 'cancelled' })
  assert.equal(h.calls.switched, 0)
})

test('探测已经返回、还没换之前取消 → 不换服务器', async () => {
  const h = probeHarness()
  const cancel = new AbortController()
  const p = h.run(cancel)
  h.calls.fetches[0].resolve({ ok: true, status: 200, json: async () => (cancel.abort(), { code: 200 }) })
  assert.deepEqual(plain(await p), { kind: 'cancelled' })
  assert.equal(h.calls.switched, 0)
})

test('探测失败分类：HTTP 错 / 不像本项目后端 / 网络错，都不换', async () => {
  for (const [res, expected] of [
    [{ ok: false, status: 502, json: async () => null }, { kind: 'http', status: 502 }],
    [{ ok: true, status: 200, json: async () => ({ hello: 1 }) }, { kind: 'not-fba' }],
  ]) {
    const h = probeHarness()
    const p = h.run(new AbortController())
    h.calls.fetches[0].resolve(res)
    assert.deepEqual(plain(await p), expected)
    assert.equal(h.calls.switched, 0)
  }
  const h = probeHarness()
  const p = h.run(new AbortController())
  h.calls.fetches[0].reject(new Error('Network request failed'))
  assert.deepEqual(plain(await p), { kind: 'network', message: 'Network request failed' })
  assert.equal(h.calls.switched, 0)
})
