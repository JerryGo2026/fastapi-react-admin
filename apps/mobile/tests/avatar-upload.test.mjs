import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * #381：头像上传必须走 `api.sendUpload`（XHR），不能走 `sendRaw` / 全局 `fetch`。
 * Expo 57 的全局 `fetch` 是 `expo/fetch`，不认 RN 的 `{ uri, name, type }` 文件描述，
 * 抛 `Unsupported FormDataPart implementation`，被包成「连不上服务器」—— 看着像网络问题。
 * 设备上那一半在 Maestro（`e2e/flows/profile-avatar.yaml`）；这里守住「走哪条传输」。
 *
 * 写法同 `server-switch.test.mjs`：TS 现场转 CommonJS、vm 里跑、`require` 换成桩。
 */

function load(relative, imports, globals = {}) {
  const filename = path.resolve(import.meta.dirname, relative)
  const js = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  vm.runInNewContext(js, {
    exports,
    ...globals,
    require: (name) => {
      assert.ok(name in imports, `没给桩：${name}`)
      return imports[name]
    },
  })
  return exports
}

class FakeFormData {
  parts = []
  append(name, value) {
    this.parts.push([name, value])
  }
}

function setup(uploaded) {
  const calls = []
  const api = {
    sendUpload: async (p, body, options) => {
      calls.push(['sendUpload', p, body, options])
      return uploaded
    },
    PUT: async (p, init) => {
      calls.push(['PUT', p, init])
      return null
    },
    // 真客户端的 sendRaw 底下就是全局 fetch（Expo 57 下是 expo/fetch）
    sendRaw: async () => assert.fail('头像上传不能走 sendRaw（fetch）：expo/fetch 不认 RN 的 { uri } 文件描述'),
  }
  const mod = load(
    '../src/lib/avatar.ts',
    {
      // 修之前的版本自己 import 它判信封；现在不该再需要
      '@admin/api': { resolveEnvelope: () => assert.fail('不该自己判信封（sendUpload 判）') },
      '@admin/i18n': { t: (s) => s },
      'expo-image-picker': {},
      '@/lib/api': { api },
      '@/lib/server': { serverStore: { current: () => 'http://10.0.2.2:8001' } },
    },
    {
      FormData: FakeFormData,
      // 碰了就是回到了那条坏掉的传输
      fetch: () => assert.fail('头像上传不能走全局 fetch（expo/fetch 不认 RN 的 { uri } 文件描述）'),
    },
  )
  return { mod, calls }
}

const asset = { uri: 'file:///cache/crop.png', mimeType: 'image/png', fileSize: 1024 }

test('上传走 sendUpload（XHR），传公开子树，再把绝对地址写回头像', async () => {
  const { mod, calls } = setup({ id: '1', public_url: '/uploads/a.png' })
  const url = await mod.uploadAvatar(asset)
  assert.equal(url, 'http://10.0.2.2:8001/uploads/a.png')
  assert.equal(calls[0][0], 'sendUpload')
  assert.equal(calls[0][1], '/api/v1/sys/files/upload?public=true')
  const [[field, file]] = calls[0][2].parts
  assert.equal(field, 'file')
  assert.equal(JSON.stringify(file), JSON.stringify({ uri: asset.uri, name: 'avatar.png', type: 'image/png' }))
  // vm 里建的对象原型来自另一个 realm，按 JSON 比
  assert.equal(JSON.stringify(calls[1]), JSON.stringify(['PUT', '/api/v1/sys/users/me/avatar', { body: { avatar: url } }]))
})

test('拿不到 public_url 就报错，不写回头像', async () => {
  const { mod, calls } = setup({ id: '1', public_url: null })
  await assert.rejects(mod.uploadAvatar(asset), /没有拿到直链/)
  assert.equal(
    calls.some((c) => c[0] === 'PUT'),
    false,
  )
})

test('上传失败原样抛给调用方（界面要显示原因），不写回头像', async () => {
  const boom = new Error('连不上服务器（http://10.0.2.2:8001）：Unable to resolve host')
  const failing = load(
    '../src/lib/avatar.ts',
    {
      '@admin/i18n': { t: (s) => s },
      'expo-image-picker': {},
      '@/lib/api': {
        api: {
          sendUpload: async () => {
            throw boom
          },
          PUT: async () => assert.fail('上传失败了还写回头像'),
        },
      },
      '@/lib/server': { serverStore: { current: () => 'http://10.0.2.2:8001' } },
    },
    { FormData: FakeFormData },
  )
  await assert.rejects(failing.uploadAvatar(asset), (e) => e === boom)
})
