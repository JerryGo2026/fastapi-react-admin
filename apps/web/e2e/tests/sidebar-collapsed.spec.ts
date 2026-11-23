import { expect, test } from "../fixtures/base"

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

  test("键盘：Enter 打开、Esc 关闭并回到触发器", async ({ authedPage: page }) => {
    const trigger = page.getByTestId("nav-group-日志管理")
    await trigger.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("nav-flyout-日志管理")).toHaveAttribute("data-open", "")
    await page.keyboard.press("Escape")
    await expect(page.locator('[data-testid="nav-flyout-日志管理"][data-open]')).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test("叶子菜单悬停出 tooltip", async ({ authedPage: page }) => {
    await page.getByTestId("nav-/dashboard").hover()
    await expect(page.locator('[data-slot="tooltip-content"]', { hasText: "仪表盘" })).toBeVisible()
  })
})
