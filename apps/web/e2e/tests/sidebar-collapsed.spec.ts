import { expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

type Menu = { id: string; name: string; path: string | null; children?: Menu[] }
const MENUS = "/api/v1/sys/menus"
const MENU_TYPE = { DIR: 0, LINK: 4 } as const

function flatten(tree: Menu[]): Menu[] {
  return tree.flatMap((m) => [m, ...flatten(m.children ?? [])])
}

/**
 * 侧边栏折叠成图标栏（⌘B）之后，分组菜单要能进子页面（#440）。
 *
 * 修之前：`SidebarMenuSub` 在 `collapsible=icon` 下是 display:none，分组点了只把 aria-expanded
 * 翻成 true、什么都不出现 —— 12 个一级菜单里 10 个是死按钮，而且不报任何错。
 */
test.describe("折叠态侧边栏", () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto("/dashboard")
    const sidebar = page.locator('[data-slot="sidebar"][data-collapsible]')
    // 按全局快捷键之前先等外壳挂上来（e2e 分册「按全局快捷键之前要先等外壳挂上来」）
    await expect(page.getByTestId("nav-group-系统管理")).toBeVisible()
    await page.keyboard.press("ControlOrMeta+b")
    await expect(sidebar).toHaveAttribute("data-collapsible", "icon")
  })

  test("悬停分组浮出子菜单，点子项进页面、浮层跟着关", async ({ authedPage: page }) => {
    const flyout = page.getByTestId("nav-flyout-系统管理")
    await page.getByTestId("nav-group-系统管理").hover()
    await expect(flyout).toHaveAttribute("data-open", "")
    await flyout.getByTestId("nav-/system/user").click()
    await expect(page).toHaveURL(/\/system\/user/)
    // 断言 data-open 不断言 toBeHidden：退场动画期间它还看得见（e2e 分册「关不掉的浮层」）
    await expect(page.locator('[data-testid="nav-flyout-系统管理"][data-open]')).toHaveCount(0)
    // 当前页所在的分组要有选中态，否则折叠后看不出自己在哪
    await expect(page.getByTestId("nav-group-系统管理")).toHaveAttribute("data-active", "")
  })

  // 用「系统监控」不用「日志管理」：`menu-rename-disable.spec.ts` 会把 /log 临时停用，并行撞上时这里找不到分组
  test("键盘：Enter 打开、Esc 关闭并回到触发器", async ({ authedPage: page }) => {
    const trigger = page.getByTestId("nav-group-系统监控")
    await trigger.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("nav-flyout-系统监控")).toHaveAttribute("data-open", "")
    await page.keyboard.press("Escape")
    await expect(page.locator('[data-testid="nav-flyout-系统监控"][data-open]')).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test("叶子菜单悬停出 tooltip", async ({ authedPage: page }) => {
    await page.getByTestId("nav-/dashboard").hover()
    await expect(page.locator('[data-slot="tooltip-content"]', { hasText: "仪表盘" })).toBeVisible()
  })

  test("三级菜单在浮层里往右级联，点里面的项两层浮层一起关", async ({ authedPage: page, api }) => {
    // 种子里没有三级菜单：在「系统管理」下临时挂一个目录 + 一条外链（外链不受前端路由校验，跑完删掉）
    const code = uniqueCode("S").replaceAll("_", "").slice(-8)
    const dirName = `E2ECascade${code}`
    const linkName = `E2ECascadeLink${code}`
    const system = ((await api.get(MENUS)) as Menu[]).find((m) => m.path === "/system")
    if (!system) throw new Error("前置：种子里要有 path=/system 的目录")
    const created: string[] = []
    const base = { sort: 999, icon: null, perms: null, status: 1, display: 1, remark: "E2E 三级级联，跑完会删" }
    try {
      await api.post(MENUS, { ...base, title: dirName, name: dirName, path: `/e2e-cascade-${code.toLowerCase()}`, parent_id: system.id, type: MENU_TYPE.DIR, link: null })
      const dir = flatten((await api.get(MENUS)) as Menu[]).find((m) => m.name === dirName)
      if (!dir) throw new Error(`目录建完却找不到：${dirName}`)
      created.unshift(dir.id)
      await api.post(MENUS, { ...base, title: linkName, name: linkName, path: `/e2e-cascade-link-${code.toLowerCase()}`, parent_id: dir.id, type: MENU_TYPE.LINK, link: "https://example.com/" })
      const link = flatten((await api.get(MENUS)) as Menu[]).find((m) => m.name === linkName)
      if (!link) throw new Error(`外链建完却找不到：${linkName}`)
      created.unshift(link.id)

      // 菜单树只在加载时取一次，要重载；SidebarProvider 不读 sidebar_state cookie，重载后回到展开态，再折叠一次
      await page.reload()
      await expect(page.getByTestId("nav-group-系统管理")).toBeVisible()
      await page.keyboard.press("ControlOrMeta+b")
      await expect(page.locator('[data-slot="sidebar"][data-collapsible]')).toHaveAttribute("data-collapsible", "icon")

      const top = page.getByTestId("nav-flyout-系统管理")
      await page.getByTestId("nav-group-系统管理").hover()
      await expect(top).toHaveAttribute("data-open", "")
      await top.getByTestId(`nav-group-${dirName}`).hover()
      const item = page.getByRole("menuitem", { name: linkName })
      await expect(item).toBeVisible()
      await expect(item).toHaveAttribute("href", "https://example.com/")

      const popup = page.waitForEvent("popup")
      await item.click()
      await (await popup).close()
      await expect(page.locator('[data-testid="nav-flyout-系统管理"][data-open]')).toHaveCount(0)
      await expect(page.locator('[data-slot="dropdown-menu-sub-content"][data-open]')).toHaveCount(0)
    } finally {
      // 先删外链再删目录：子项挡着目录删不掉
      for (const id of created) await api.del(`${MENUS}/${id}`).catch(() => {})
    }
  })
})

/**
 * 偏好「子菜单展开方式 = 悬停浮出」：展开态的分组也走浮层（#440 第二步）。默认是内嵌展开，
 * 上面那组用例和其余 spec 跑的都是默认值；这里切过去、刷新还在、切回来恢复内嵌。
 */
test("偏好切到悬停浮出：展开态也从右侧弹出，刷新还在，折叠照样弹，切回内嵌恢复", async ({ authedPage: page }) => {
  await page.goto("/profile?section=layout")
  await page.getByTestId("pref-sidebar-submenu-flyout").click()
  // 侧边栏是展开态，没有按 ⌘B
  await expect(page.locator('[data-slot="sidebar"][data-state="expanded"]')).toHaveCount(1)

  const trigger = page.getByTestId("nav-group-系统监控")
  await trigger.hover()
  await expect(page.getByTestId("nav-flyout-系统监控")).toHaveAttribute("data-open", "")

  await page.reload()
  await page.getByTestId("nav-group-系统监控").hover()
  await expect(page.getByTestId("nav-flyout-系统监控")).toHaveAttribute("data-open", "")

  // 折叠也照样浮出（偏好只管展开态；折叠态两种偏好都走浮层，默认值那一侧由上面那组用例覆盖）
  await page.mouse.move(900, 600)
  await expect(page.locator('[data-testid^="nav-flyout-"][data-open]')).toHaveCount(0)
  await page.keyboard.press("ControlOrMeta+b")
  await expect(page.locator('[data-slot="sidebar"][data-collapsible]')).toHaveAttribute("data-collapsible", "icon")
  await page.getByTestId("nav-group-系统监控").hover()
  await expect(page.getByTestId("nav-flyout-系统监控")).toHaveAttribute("data-open", "")
  await page.mouse.move(900, 600)
  await expect(page.locator('[data-testid^="nav-flyout-"][data-open]')).toHaveCount(0)
  await page.keyboard.press("ControlOrMeta+b")
  await expect(page.locator('[data-slot="sidebar"][data-state="expanded"]')).toHaveCount(1)

  // 🔴 悬停打开的浮层开着时 body 是 `pointer-events: none`（实测），页面别处点不到 —— Playwright 报「<html> intercepts
  // pointer events」、一直重试到超时，因为它不挪鼠标。人会先把鼠标移开、浮层关掉，这里照做
  await page.mouse.move(900, 600)
  await expect(page.locator('[data-testid^="nav-flyout-"][data-open]')).toHaveCount(0)
  await page.getByTestId("pref-sidebar-submenu-inline").click()
  await page.getByTestId("nav-group-系统监控").click()
  await expect(page.getByTestId("nav-group-系统监控")).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator('[data-testid^="nav-flyout-"][data-open]')).toHaveCount(0)
})
