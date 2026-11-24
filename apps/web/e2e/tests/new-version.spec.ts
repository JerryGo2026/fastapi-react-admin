import { expect, test } from "../fixtures/base"

/**
 * 「服务端发新版了，请刷新」（见 `apps/web/src/lib/app-version.ts`）。
 *
 * 造假响应是**必要**的，理由同 `list-error.spec.ts`：真实环境里「发新版」
 * 这件事没法在一条测试里发生 —— 要么真去构建两次，要么让服务器报一个
 * 不一样的 buildId。这里用 `page.route` 直接给 `/version.json` 换个值。
 *
 * ⚠️ 开发服务器上**没有** `version.json`（它是构建产物），所以第二条断言
 * （404 不能被当成发新版）验的是真实的开发期行为，不是假设。
 */
test.describe("新版本提示", () => {
  test("服务端 buildId 变了 → 弹一张带「立即刷新」的卡片，显示新旧版本号", async ({ authedPage: page }) => {
    await page.route("**/version.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ buildId: "e2e-new-build", version: "99.0.0" }),
      })
    )

    await page.goto("/dashboard")

    const notice = page.getByTestId("update-notice")
    await expect(notice).toContainText("新版本已就绪")
    // 新版本号来自 version.json；旧版本号是这份前端自己编译进去的，不写死
    await expect(notice.getByTestId("update-notice-versions")).toContainText("v99.0.0")
    // 🔴 不能自动刷新 —— 用户可能正在填一张长表单。只给按钮
    await expect(notice.getByTestId("update-notice-reload")).toBeVisible()
    await expect(page).toHaveURL(/\/dashboard/)

    // 「稍后」关掉这一张（同一页之后的轮询不会再弹，见 app-version.ts 的 notified）
    await notice.getByTestId("update-notice-later").click()
    await expect(notice).toBeHidden()
  })

  test("version.json 里没有 version 时照样提示，只是不显示版本那一行", async ({ authedPage: page }) => {
    await page.route("**/version.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ buildId: "e2e-new-build" }),
      })
    )

    await page.goto("/dashboard")

    const notice = page.getByTestId("update-notice")
    await expect(notice.getByTestId("update-notice-reload")).toBeVisible()
    await expect(notice.getByTestId("update-notice-versions")).toHaveCount(0)
  })

  /**
   * 懒加载失败那条路：手里没有版本号，`notifyNewVersion()` 要自己现取一次 `version.json`。
   *
   * 让 `version.json` 回 `buildId: "dev"`（开发期编译进去的就是它）—— 轮询那条路判定「没换版」、
   * 不会抢先弹，卡片只可能来自懒加载失败这一支，显示的版本号也只可能是现取到的那个。
   * 失败本身用一个未处理的 rejection 造：浏览器真实的报错文案，`isStaleAssetError` 认的就是它。
   */
  test("懒加载分片取不到 → 弹卡片，版本号是现取的", async ({ authedPage: page }) => {
    let fetched = 0
    await page.route("**/version.json", (route) => {
      fetched += 1
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ buildId: "dev", version: "99.1.0" }),
      })
    })

    await page.goto("/dashboard")
    await expect(page.getByTestId("dash-greeting")).toBeVisible()
    // 轮询那一次已经回来了，而且没弹 —— 否则下面断言的卡片分不清是谁弹的
    await expect.poll(() => fetched).toBeGreaterThan(0)
    await expect(page.getByTestId("update-notice")).toHaveCount(0)

    await page.evaluate(() => {
      void Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/viewer-gone.js"))
    })

    const notice = page.getByTestId("update-notice")
    await expect(notice.getByTestId("update-notice-versions")).toContainText("v99.1.0")
    await expect(notice.getByTestId("update-notice-reload")).toBeVisible()
  })

  test("懒加载分片取不到、version.json 也取不到 → 照样弹，只是没有版本行", async ({ authedPage: page }) => {
    await page.goto("/dashboard")
    await expect(page.getByTestId("dash-greeting")).toBeVisible()

    await page.evaluate(() => {
      void Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/viewer-gone.js"))
    })

    const notice = page.getByTestId("update-notice")
    await expect(notice.getByTestId("update-notice-reload")).toBeVisible()
    await expect(notice.getByTestId("update-notice-versions")).toHaveCount(0)
  })

  test("拿不到 version.json（开发期就是这样）不能弹提示", async ({ authedPage: page }) => {
    await page.goto("/dashboard")
    await expect(page.getByTestId("dash-greeting")).toBeVisible()
    await expect(page.getByTestId("toast")).toHaveCount(0)
  })
})
