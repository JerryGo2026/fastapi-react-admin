import type { Locator, Page } from "@playwright/test"

import { createApiClient, expect, loginPageAs, test } from "../fixtures/base"

/**
 * 多页签 × 浮层的边界（#421）。
 *
 * `workflow.spec.ts`「填到一半切走再切回来」只在默认的**内容区滚动**下验了应用内切换。这里补三块：
 *
 * 1. **两种滚动方式都跑一遍**（偏好 `scrollMode` → `<html data-scroll-mode>`）。整页滚动时滚的是视口本身，
 *    Base UI 模态浮层的滚动锁（`<html data-base-ui-scroll-locked>` + `overflow: hidden`）锁的就是它 ——
 *    后台页签里「开着」的抽屉要是还拿着锁，前台那一页滚不动，而且没有任何报错。
 * 2. **整页刷新**：后台页签从 sessionStorage 恢复，`?start=` 还在，抽屉以「打开」挂载 —— 原始 bug 的现场
 *    （shell 分册「开在 URL 上的浮层，portal 要挂进本 tab 的根节点」）。
 * 3. **不该跟着页签走的浮层**：行操作菜单 / 顶栏铃铛照旧挂 `<body>`，贴着滚动区底边打开也完整可见、
 *    在最上层、焦点进出正确，打开关上不改滚动位置。
 *
 * 用 admin 发起：流程定义现建，编码带时间戳（有过实例的定义删不掉，这里也不提交实例）。
 * 视口压到 560 高，保证用户管理页在两种模式下都有东西可滚。
 */
const CODE = `E2ETOB_${Date.now().toString(36).toUpperCase()}`
const INBOX = "/_auth/workflow/inbox"
const USER = "/_auth/system/user"
const MODES = ["page", "content"] as const
type Mode = (typeof MODES)[number]

test.describe.configure({ mode: "serial" })
test.use({ viewport: { width: 1280, height: 560 } })

let definitionId = ""

test.beforeAll(async () => {
  const { api, dispose } = await createApiClient()
  const created = (await api.post("/api/v1/sys/workflow/definitions", {
    code: CODE,
    name: `E2E 浮层边界 ${CODE}`,
    category: "E2E",
    form: { schemaVersion: 1, fields: [{ id: "f_reason", type: "text", label: "事由", required: true }] },
    model: {
      schemaVersion: 1,
      root: {
        type: "start",
        id: "start",
        next: {
          type: "approval", id: "n1", name: "主管", mode: "any",
          assignee: { kind: "dept_leader", level: 1 }, onEmpty: "reject", next: null,
        },
      },
    },
  })) as { id: string }
  definitionId = created.id
  await api.post(`/api/v1/sys/workflow/definitions/${definitionId}/publish`)
  await dispose()
})

test.afterAll(async () => {
  // 停用：删不掉的定义留着启用的话，会进所有人的「快速发起」
  const { api, dispose } = await createApiClient()
  await api.put(`/api/v1/sys/workflow/definitions/${definitionId}/status`, { enabled: false }).catch(() => undefined)
  await dispose()
})

/** 偏好存在 localStorage（zustand persist，`admin:prefs`），React 挂载前就读 —— 每次导航前写好 */
async function useScrollMode(page: Page, mode: Mode) {
  await page.addInitScript((m) => {
    localStorage.setItem("admin:prefs", JSON.stringify({ state: { scrollMode: m }, version: 0 }))
  }, mode)
}

/** 应用内导航（不是 goto：整页刷新本来就会丢内存状态）。字符串形式：e2e 的 tsconfig 不带 DOM 类型 */
async function pushPath(page: Page, path: string) {
  await page.evaluate(`history.pushState({}, "", "${path}"); dispatchEvent(new PopStateEvent("popstate"))`)
}

/** 两种模式的滚动位置：视口自己的 + 前台页签里所有内滚容器里最大的那个 */
async function scrollState(page: Page, routeId: string): Promise<{ win: number; inner: number }> {
  return page.evaluate(`(() => {
    const tab = document.querySelector('[data-tab="${routeId}"]')
    // 外壳的内容层是页签的祖先，从页签往上找（硬纪律 5：不裸查 document）
    const shell = tab ? tab.closest('[data-slot="content-scroll"]') : null
    const els = [shell, ...(tab ? tab.querySelectorAll('*') : [])].filter(Boolean)
    return { win: window.scrollY, inner: Math.max(0, ...els.map((e) => e.scrollTop)) }
  })()`)
}

/** 在前台页签上滚轮，断言**该滚的那一层**真的滚了 —— 这一句就是「区分两种模式」的落点 */
async function expectFrontScrolls(page: Page, mode: Mode, front: Locator) {
  await expect(page.locator("html")).toHaveAttribute("data-scroll-mode", mode)
  const box = await front.locator('[data-slot="table-container"]').first().boundingBox()
  expect(box, "前台页签里应该有表格").not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, Math.min(box!.y + 40, 540))
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 400)
      const s = await scrollState(page, USER)
      return mode === "page" ? s.win > 0 : s.win === 0 && s.inner > 0
    }, { message: `${mode} 模式下前台应该能滚（page = 视口滚，content = 视口不动、内容区里滚）` })
    .toBe(true)
}

/**
 * Base UI 的滚动锁有两条实现：滚动条占位的（加 `data-base-ui-scroll-locked` + 改 `scrollbar-gutter`）和
 * 覆盖式滚动条的（只在 `<html>` / `<body>` 上写内联 `overflow: hidden`，**不加任何属性**）。
 * 无头 Chromium 的页面不溢出时走后一条 —— 只认属性的话「锁着」也读成「没锁」。两条都认
 */
function pageLocked(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const h = document.documentElement, b = document.body
    return h.hasAttribute("data-base-ui-scroll-locked") || /hidden|clip/.test(h.style.overflowY) || /hidden|clip/.test(b.style.overflowY)
  })()`)
}

/** 前台没被后台浮层拿住：没有滚动锁、自己和祖先都不 inert */
async function expectFrontFree(page: Page, front: Locator) {
  await expect.poll(() => pageLocked(page), { message: "后台抽屉不该还拿着滚动锁" }).toBe(false)
  expect(await front.evaluate((el) => !!el.closest("[inert]") || el.closest("[aria-hidden=true]") !== null)).toBe(false)
}

/** 前台点得动：开一个行操作菜单再 Esc 关掉（后台抽屉的遮罩还在的话，点击会被它接走、超时） */
async function expectFrontClickable(page: Page, front: Locator) {
  const trigger = front.locator('[data-testid^="row-actions-"]').first()
  await trigger.click({ timeout: 5_000 })
  const menu = page.locator('[data-slot="dropdown-menu-content"][data-open]')
  await expect(menu).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
}

for (const mode of MODES) {
  test(`[${mode}] 后台页签里开着的抽屉：不锁滚动、不挡前台；切回来抽屉和输入原样还在`, async ({ page }) => {
    await useScrollMode(page, mode)
    await loginPageAs(page, "admin", "123456")
    await page.goto(`/workflow/inbox?start=${CODE}`)
    const sheet = page.getByTestId("wf-start-sheet")
    const input = sheet.getByTestId("wf-field-f_reason").locator("input")
    await input.fill("填了一半")
    // 给这个输入框节点打个记号：草稿还会从本地存储恢复，只看值分不出「保活」和「重挂后恢复」
    await input.evaluate((el) => el.setAttribute("data-i421", "kept"))
    // 抽屉开着时外面确实被锁着 —— 不先确认这一句，后面「锁解除了」可能是压根没锁过
    await expect.poll(() => pageLocked(page)).toBe(true)

    await pushPath(page, "/system/user")
    const front = page.locator(`[data-tab="${USER}"]`)
    await expect(front).toHaveAttribute("data-visible", "true")
    await expect(sheet).toBeHidden()
    await expect(front.locator('[data-testid^="row-actions-"]').first()).toBeVisible()
    await expectFrontFree(page, front)
    await expectFrontClickable(page, front)
    await expectFrontScrolls(page, mode, front)

    // 外壳级弹层（挂 <body>，不在任何页签里）照常可用：铃铛面板在最上层、点得到
    await page.getByTestId("notification-bell").click()
    const panel = page.getByTestId("notification-panel")
    await expect(panel).toBeVisible()
    expect(await panel.evaluate((el) => el.closest("[data-tab]") === null)).toBe(true)
    await page.keyboard.press("Escape")
    await expect(panel).toBeHidden()
    await expect(page.getByTestId("notification-bell")).toBeFocused()

    await page.getByTestId(`tab-${INBOX}`).click()
    await expect(sheet).toBeVisible()
    await expect(input).toHaveValue("填了一半")
    await expect(input).toHaveAttribute("data-i421", "kept")
    // 回到前台，锁重新拿上（effect 被 <Activity> 重建）
    await expect.poll(() => pageLocked(page)).toBe(true)
  })

  test(`[${mode}] 刷新后从 sessionStorage 恢复的后台页签：抽屉不挡前台、不锁滚动，点回去才出现`, async ({ page }) => {
    await useScrollMode(page, mode)
    await loginPageAs(page, "admin", "123456")
    await page.goto(`/workflow/inbox?start=${CODE}`)
    const sheet = page.getByTestId("wf-start-sheet")
    await expect(sheet).toBeVisible()
    await pushPath(page, "/system/user")
    const front = page.locator(`[data-tab="${USER}"]`)
    await expect(front).toHaveAttribute("data-visible", "true")

    await page.reload()
    await expect(front).toHaveAttribute("data-visible", "true")
    // 后台页签确实恢复出来了，而且带着 ?start= —— 抽屉在它里面「开着」挂载
    await expect(page.getByTestId(`tab-${INBOX}`)).toBeVisible()
    await expect(page.locator(`[data-tab="${INBOX}"]`)).toHaveAttribute("data-visible", "false")
    await expect(front.locator('[data-testid^="row-actions-"]').first()).toBeVisible()
    await expect(sheet).toBeHidden()
    await expectFrontFree(page, front)
    await expectFrontClickable(page, front)
    await expectFrontScrolls(page, mode, front)

    // 点回去：抽屉这才真正打开（恢复时它在后台，见下面「实测」）
    await page.getByTestId(`tab-${INBOX}`).click()
    await expect(sheet).toBeVisible()
    await expect(sheet.getByTestId("wf-start-title")).toHaveText(`E2E 浮层边界 ${CODE}`)
    await expect.poll(() => pageLocked(page)).toBe(true)

    // 再切走一次：恢复出来的页签拿到的根节点同样接得住 portal（原始 bug 的现场是「刷新后再去别的页」）
    await pushPath(page, "/system/user")
    await expect(front).toHaveAttribute("data-visible", "true")
    await expect(sheet).toBeHidden()
    await expectFrontFree(page, front)
    await expectFrontClickable(page, front)
  })

  test(`[${mode}] 贴着滚动区底边打开行操作菜单：挂 <body>、完整可见、在最上层，焦点进出正确、不改滚动位置`, async ({ page }) => {
    await useScrollMode(page, mode)
    await loginPageAs(page, "admin", "123456")
    await page.goto("/system/user")
    const front = page.locator(`[data-tab="${USER}"]`)
    const triggers = front.locator('[data-testid^="row-actions-"]')
    await expect(triggers.first()).toBeVisible()
    await expectFrontScrolls(page, mode, front)
    // 滚到底：最后一行的 ⋯ 贴着可视区下沿
    const last = triggers.last()
    await page.mouse.wheel(0, 5000)
    await last.scrollIntoViewIfNeeded()
    const before = await scrollState(page, USER)

    await last.click()
    const menu = page.locator('[data-slot="dropdown-menu-content"][data-open]')
    await expect(menu).toBeVisible()
    // 门户容器：不在任何页签里（挂进页签 = 进了会滚、会被 display:none 的那棵树）
    expect(await menu.evaluate((el) => el.closest("[data-tab]") === null)).toBe(true)
    // 完整落在视口里（贴底时应当翻到上方，而不是被可视区下沿裁掉）
    const vp = page.viewportSize()!
    const box = (await menu.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
    // 层级：每一项中心点上「最上面的那个元素」就是它自己（没被表格 / 粘性表头 / 页签盖住）
    // 禁用项（admin 删不了自己）带 pointer-events: none，命中测试会穿过它 —— 只测能点的
    const items = menu.locator('[role="menuitem"]:not([data-disabled])')
    const n = await items.count()
    expect(n).toBeGreaterThan(0)
    for (let i = 0; i < n; i++) {
      const hit = await items.nth(i).evaluate((el) => {
        const r = el.getBoundingClientRect()
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return !!top && el.contains(top)
      })
      expect(hit, `第 ${i + 1} 项被别的东西盖住了`).toBe(true)
    }
    // 焦点进了菜单；键盘能走到第一项
    expect(await menu.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await page.keyboard.press("ArrowDown")
    expect(await menu.evaluate((el) => el.contains(document.activeElement))).toBe(true)

    await page.keyboard.press("Escape")
    await expect(menu).toBeHidden()
    await expect(last).toBeFocused()
    expect(await scrollState(page, USER)).toEqual(before)
  })
}
