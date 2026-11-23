import type { ReactNode } from 'react'
import { menuTitle } from '@admin/i18n'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { IconAlertTriangle, IconChevronRight, IconExternalLink } from '@tabler/icons-react'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@admin/ui/components/collapsible'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar as useSidebarLayout,
} from '@admin/ui/components/sidebar'
import { Skeleton } from '@admin/ui/components/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { cn } from '@admin/ui/lib/utils'

import { usePerm } from '../../auth/use-perm'
import { MenuIcon } from '../icon-registry'
import { useSidebar, type NavNode, type SidebarOptions } from './use-sidebar'

/**
 * 侧边栏节点。
 *
 * ⚠️ 同一层级必须用同一套组件，否则会错位：
 * 顶层用 `SidebarMenuItem` + `SidebarMenuButton`，
 * 子层用 `SidebarMenuSubItem` + `SidebarMenuSubButton`（两者内边距不同）。
 * 之前「有子项的子菜单」误用了顶层组件 + 额外 ps-1，
 * 导致「数据权限」比同级的「菜单管理」「数据字典」多缩进一截。
 */
function NavItem({
  node,
  activePath,
  nested = false,
}: {
  node: NavNode
  activePath: string
  nested?: boolean
}) {
  const { t } = useTranslation()
  const { state, isMobile } = useSidebarLayout()
  const railMode = state === 'collapsed' && !isMobile
  const hasChildren = node.children.length > 0
  const isActive = node.path === activePath
  const containsActive = React.useMemo(
    () => hasChildren && subtreeHasPath(node, activePath),
    [node, activePath, hasChildren]
  )

  // 受控展开：菜单树是异步到达的，用 defaultOpen 会触发
  // 「uncontrolled → controlled」警告，且首次渲染时 containsActive 还是 false。
  // 用户手动折叠后不再被 activePath 强行拉开。
  const [open, setOpen] = React.useState(containsActive)
  const touched = React.useRef(false)
  React.useEffect(() => {
    if (!touched.current && containsActive) setOpen(true)
  }, [containsActive])

  const Item = nested ? SidebarMenuSubItem : SidebarMenuItem
  const ItemButton = nested ? SidebarMenuSubButton : SidebarMenuButton
  const iconClass = nested ? 'size-3.5' : undefined
  const title = menuTitle(t, node.path, node.title)
  // 折叠成图标栏后只剩图标：顶层叶子靠 tooltip 报名字（`tooltip` 只在折叠态显示）。子层组件没有这个 prop，
  // 也用不着 —— 折叠态下子层只出现在浮层里（#440）
  const tip = nested ? {} : { tooltip: title }

  // ── 叶子节点 ──
  if (!hasChildren) {
    if (node.external) {
      return (
        <Item>
          <ItemButton {...tip} render={<a href={node.external} target="_blank" rel="noreferrer" />}>
            <MenuIcon name={node.icon} className={iconClass} />
            <span>{title}</span>
            <IconExternalLink className="ms-auto size-3 opacity-50" />
          </ItemButton>
        </Item>
      )
    }
    return (
      <Item>
        <ItemButton
          {...tip}
          isActive={isActive}
          data-testid={`nav-${node.path}`}
          render={<Link to={node.path as never} />}
        >
          <MenuIcon name={node.icon} className={iconClass} />
          <span>{title}</span>
        </ItemButton>
      </Item>
    )
  }

  // ── 折叠态的分组：悬停 / 点击从右侧浮出子菜单（#440） ──
  // 🔴 不能沿用下面的 Collapsible：`SidebarMenuSub` 在 `collapsible=icon` 下是 display:none，
  // 点了只会把 aria-expanded 翻成 true，什么都不出现 —— 折叠后 12 个一级菜单里 10 个是这种死按钮
  if (railMode && !nested) {
    return (
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            openOnHover
            // closeDelay 要 ≤ delay：每个分组是各自独立的菜单，不互相协调，反过来的话在相邻分组间移动时
            // 旧浮层还没关、新浮层已经开，两个叠在一起闪一下。移进浮层靠 Base UI 的 safe polygon，不靠关闭延迟
            delay={120}
            closeDelay={100}
            render={
              <SidebarMenuButton isActive={containsActive} aria-label={title} data-testid={`nav-group-${node.title}`} />
            }
          >
            <MenuIcon name={node.icon} />
            <span>{title}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="right"
            align="start"
            sideOffset={8}
            className="w-auto min-w-44"
            data-testid={`nav-flyout-${node.title}`}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>{title}</DropdownMenuLabel>
              {node.children.map((c) => (
                <FlyoutNode key={c.id} node={c} activePath={activePath} />
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    )
  }

  // ── 可展开分组 ──
  return (
    <Collapsible
      open={open}
      onOpenChange={(o) => {
        touched.current = true
        setOpen(o)
      }}
      className="group/collapsible"
    >
      <Item>
        <CollapsibleTrigger render={<ItemButton data-testid={`nav-group-${node.title}`} />}>
          <MenuIcon name={node.icon} className={iconClass} />
          <span>{title}</span>
          <IconChevronRight className="ms-auto size-4 shrink-0 transition-transform group-data-[panel-open]/collapsible:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {node.children.map((c) => (
              <NavItem key={c.id} node={c} activePath={activePath} nested />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Item>
    </Collapsible>
  )
}

/** 折叠态浮层里的一项：叶子是真链接（中键 / ⌘+点击照旧新开），分组往右级联 */
function FlyoutNode({ node, activePath }: { node: NavNode; activePath: string }) {
  const { t } = useTranslation()
  const title = menuTitle(t, node.path, node.title)
  const icon = <MenuIcon name={node.icon} className="size-3.5" />

  if (node.children.length > 0) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          data-testid={`nav-group-${node.title}`}
          className={cn(subtreeHasPath(node, activePath) && 'font-medium text-primary')}
        >
          {icon}
          <span>{title}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-40">
          {node.children.map((c) => (
            <FlyoutNode key={c.id} node={c} activePath={activePath} />
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }

  if (node.external) {
    return (
      <DropdownMenuLinkItem closeOnClick render={<a href={node.external} target="_blank" rel="noreferrer" />}>
        {icon}
        <span>{title}</span>
        <IconExternalLink className="ms-auto size-3 opacity-50" />
      </DropdownMenuLinkItem>
    )
  }

  const active = node.path === activePath
  return (
    // closeOnClick：LinkItem 默认点了不关（实测：跳到用户管理后浮层还挂在页面上）
    <DropdownMenuLinkItem
      closeOnClick
      data-testid={`nav-${node.path}`}
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(active && 'font-medium text-primary')}
      render={<Link to={node.path as never} />}
    >
      {icon}
      <span>{title}</span>
    </DropdownMenuLinkItem>
  )
}

function subtreeHasPath(node: NavNode, path: string): boolean {
  if (node.path === path) return true
  return node.children.some((c) => subtreeHasPath(c, path))
}

/**
 * 外壳数据取不到时侧边栏里的那一行：整行是重试按钮。折叠成图标栏时只剩警告图标，
 * 文字进 tooltip（`SidebarMenuButton` 的 `tooltip` 只在折叠态显示）。
 */
function ShellLoadError({
  label,
  error,
  onRetry,
  testId,
}: {
  label: string
  error: unknown
  onRetry: () => void
  testId: string
}) {
  const detail = (error as { message?: string } | null)?.message
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={onRetry}
        tooltip={label}
        title={detail}
        className="h-auto items-start whitespace-normal text-destructive hover:text-destructive"
        data-testid={testId}
        role="alert"
      >
        <IconAlertTriangle className="mt-0.5" />
        {/* 用 div 不用 span：按钮自带 `[&>span:last-child]:truncate`，长提示会被截成「部分按钮暂不…」（ego 实测） */}
        <div className="min-w-0">{label}</div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * `mark` 和 `title` 走 props 注入：品牌标识属于应用，platform 不能反向
 * import apps/web（依赖方向单向）。不传就退化成标题首字的方块。
 */
export function AppSidebar({
  options,
  title,
  mark,
}: {
  options: SidebarOptions
  title?: string
  mark?: ReactNode
}) {
  const { t } = useTranslation()
  // 默认标题不能写进参数默认值 —— 默认值在 hook 之前求值，调不了 t()
  const label = title ?? t('管理平台')
  const { nav, isPending, failed, error, retry } = useSidebar(options)
  const { codesFailed, codesError, retryCodes } = usePerm()
  const activePath = useRouterState({ select: (s) => s.location.pathname })

  return (
    <Sidebar collapsible="icon" data-tour="sidebar">
      <SidebarHeader>
        {/*
          折叠态必须去掉内层 `px-2` 并改成居中，否则 logo 比下面的导航图标右偏 6px。
          rail 宽 48px（`--sidebar-width-icon`），两边的居中基准本来不一样：
            导航图标：SidebarGroup 的 p-2(8) + 按钮折叠成 size-8(32) → 8~40，中心 24 ✓
            logo    ：SidebarHeader 的 p-2(8) + 这里的 px-2(8) + size-7(28) → 16~44，中心 30 ✗
          px-0 + justify-center 后 logo 落在 10~38，中心也是 24，与导航图标对齐。
          （`px-2` 和 `group-data-*:px-0` 变体作用域不同，twMerge 不会互相消解 ——
           两条都会留在 class 里，靠属性选择器的特异性让折叠态那条胜出，这是想要的。）
        */}
        <div className="flex items-center gap-2 px-2 py-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            {mark ?? label.slice(0, 1)}
          </div>
          <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">{label}</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu data-testid="sidebar-nav">
            {isPending
              ? Array.from({ length: 5 }).map((_, i) => (
                  <SidebarMenuItem key={i}>
                    <Skeleton className="h-8 w-full" />
                  </SidebarMenuItem>
                ))
              : nav.map((n) => <NavItem key={n.id} node={n} activePath={activePath} />)}
            {/* 🔴 两份外壳数据失败都画在这里（#397）。工作台自己有一块 contextError，但深链进别的页面时
                那块不在：侧边栏空着、`<Can>` 按钮全没了，而两条查询都是 retry:false + staleTime:Infinity，
                不点重试永远不会恢复。侧边栏是唯一每一页都在的地方 */}
            {failed && (
              <ShellLoadError label={t('菜单加载失败，点此重试')} error={error} onRetry={retry} testId="sidebar-error" />
            )}
            {codesFailed && (
              <ShellLoadError
                label={t('权限加载失败，部分按钮暂不显示，点此重试')}
                error={codesError}
                onRetry={retryCodes}
                testId="perm-codes-error"
              />
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
