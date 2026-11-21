import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

// 回滚步骤（#393）：`<新>` 写成 sha-<短 SHA>，而日常部署拉的是 TAG=latest —— 本地没有这个 sha 标签的镜像。
// `docker compose run` 找不到就直连 ghcr.io 去拉，绕过 FBA_PULL_MIRROR（国内几十 KB/s），
// 第 3 步时站点已经 down 了。所以第一次用 TAG=<新> 跑容器之前，必须先 `TAG=<新> bash prod.sh pull`（走加速器 + retag）。
const docs = [
  "deploy/README.md",
  "apps/docs/src/content/docs/reference/upgrade.md",
  "apps/docs/src/content/docs/en/reference/upgrade.md",
]

for (const doc of docs) {
  test(`${doc}：用 TAG=<新> 跑容器之前先 prod.sh pull`, () => {
    const text = readFileSync(
      fileURLToPath(new URL(`../../${doc}`, import.meta.url)),
      "utf8"
    )
    const newTag = /TAG=<(?:新|new)>/.source
    const firstRun = text.search(
      new RegExp(`${newTag} (?:docker compose|bash prod\\.sh up)`)
    )
    assert.ok(firstRun >= 0, "没找到用 TAG=<新> 起容器的那一步")
    const pull = text.search(new RegExp(`${newTag} bash prod\\.sh pull`))
    assert.ok(
      pull >= 0 && pull < firstRun,
      "TAG=<新> 的第一次 run / up 之前没有 TAG=<新> bash prod.sh pull"
    )
  })
}
