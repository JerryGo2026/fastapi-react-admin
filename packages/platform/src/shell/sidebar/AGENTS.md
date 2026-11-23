# platform/shell/sidebar —— 侧边栏（数据 + 渲染）

> 这份文件是 [`shell` 分册](../AGENTS.md) 的**子分册**（2026-11-23 从那份里拆出来：那份超了 500 行预算，#440），
> Claude Code 读到本目录下的文件时才把它加载进上下文。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。同层组件不能混用（`SidebarMenuButton` / `SidebarMenuSubButton`）见根 `CLAUDE.md` 硬纪律 8。

| 文件 | 职责 |
|---|---|
| `use-sidebar.ts` | 唯一数据源：`GET /sys/menus/sidebar` → `toNavTree()` → `NavNode[]`，侧边栏 / ⌘K / 工作台 / 标签条共用 |
| `app-sidebar.tsx` | 渲染：展开态内嵌展开，折叠态（⌘B）浮层 |

## 100% 服务端驱动，client-only 节点是特例不是常态

`sidebar/use-sidebar.ts: useSidebar()` 是**唯一**数据源：`GET /sys/menus/sidebar` →
`toNavTree()` → `NavNode[]`。`AppSidebar`（渲染）和 `command-menu.tsx`（⌘K 的
「页面」组）各自调一次这个 hook，但吃的是同一份 `sidebarQuery` 缓存——这意味着
**新增一个 `sys_menu` 行，两处自动一起更新，不用单独接线**。

🔴 **反过来，不挂 `sys_menu` 的页面 = 侧边栏和 ⌘K 都看不见它，没有例外。**
`/sandbox/*` 那几个页面（组件沙箱等）故意不占用业务权限码（路由文件自己写了
"只要登录就能进，不挂业务权限码"），所以它们从来没有 `sys_menu` 行——
`packages/i18n` 的语言包里其实一直留着 `menu:/sandbox`／`menu:/sandbox/components`
这两条翻译（连 en-US 都有），像是当初设计过要接、后来没接上就晾在那——
组件本身能跑、直接敲 URL 能进，但界面上找不到任何入口，是能反复复现的坑，
不是一次性的疏忽。

**修法是给 `useSidebar()` 本身打一个 client-side 合成节点**（`use-sidebar.ts`
的 `buildDevToolsNode()`），跟服务端菜单树拼在一起返回。这样只用改一个地方，
`AppSidebar` 和 `command-menu.tsx` 都自动拿到，不用分别接线。合成节点是否露出
挂在 `dev-sandbox/api.ts` 的 `readSandboxGate()`（参数配置 DEV 组的开关）上，
跟页面内容自己的显隐判断复用同一份开关，两处不会对不上。

⚠️ **这条`shell → pages/dev-sandbox` 的 import 方向不寻常**（`shell` 一般更
底层，不应该反过来认识某个具体页面），是刻意的例外：没有更通用的「client-only
导航节点」注册机制，专门为一个节点造一套框架投入产出不成比例。**只有「不挂
`sys_menu` 又需要导航入口」这一类页面才走这条路**，业务页面该走
`sys_menu` 就老老实实走，别学它。

⚠️ 合成节点的 `path` 复用现成的 `menu:/sandbox` / `menu:/sandbox/components`
i18n key（而不是随手起新字符串），两个语言的翻译已经现成，不用再补。
父节点（目录，带 children）的 `path` 不需要对应一个真实路由——`NavItem`
里点开目录只是展开子项、不会真的导航，`isValidPath` 校验只发生在
`toNavTree()` 里，合成节点整个绕过了那条校验。

## 🔴 折叠态（⌘B）的分组要走浮层，不能沿用 Collapsible（#440）

**症状**：折叠成图标栏后，分组菜单点了没反应、悬停也没提示，子页面只能靠 ⌘K 进（正式环境 12 个一级菜单里 10 个）。
**根因**：shadcn 的 `SidebarMenuSub` 带 `group-data-[collapsible=icon]:hidden`，`CollapsibleTrigger` 照样翻 `aria-expanded`，内容却是 `display:none`；shadcn 只给叶子留了 `tooltip`。
**修法**：`state === 'collapsed' && !isMobile` 时顶层分组换成 `DropdownMenu`（`openOnHover`、`side="right"`），三级用 `DropdownMenuSub` 级联，顶层叶子补 `tooltip`，触发器 `isActive={containsActive}`。
浮层叶子是 `DropdownMenuLinkItem` + `<Link>`，**必须 `closeOnClick`** —— LinkItem 默认不关，实测跳页后浮层还挂着。浮层 testid `nav-flyout-${title}`，只在打开时挂载。
**实测证据**（2026-11-23）：修前 ego 在正式环境 v1.1.3 点「系统管理」，`aria-expanded="true"`、子菜单 `display:none`、`[role=menu]` 0 个。
E2E `sidebar-collapsed.spec.ts` 4 条过；变异关掉折叠分支，浮层 / 键盘两条红；去掉外链项的 `closeOnClick`，三级那条红在「两层浮层都关了」。
三级菜单种子里没有：那条用 `api` 在「系统管理」下临时建「目录 → 外链」。⚠️ 别的 spec 会临时停用 /log，折叠态用例别拿「日志管理」测。
- `closeDelay` 要 ≤ `delay`：分组是各自独立的菜单、不互相协调，反过来在相邻分组间移动时两个浮层会叠在一起
- ⚠️ `SidebarProvider` 只写 `sidebar_state` cookie、不读：整页刷新后侧栏回到展开态。E2E 刷新后要再按一次 ⌘B
