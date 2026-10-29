"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Building2, LayoutDashboard, Lightbulb, ListChecks, PenLine, ScanEye } from "lucide-react"
import { cn } from "@/lib/utils"

const ITEMS = [
  { href: "/", label: "工作台", icon: LayoutDashboard },
  { href: "/new", label: "记一笔", icon: PenLine },
  { href: "/records", label: "支持记录", icon: ListChecks },
  { href: "/customers", label: "客户", icon: Building2 },
  { href: "/requirements", label: "需求池", icon: Lightbulb },
]

export function Nav() {
  const pathname = usePathname()
  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href))

  return (
    <aside className="sticky top-0 z-20 border-b bg-background md:h-screen md:w-56 md:shrink-0 md:border-r md:border-b-0">
      <div className="flex items-center gap-2 px-4 py-3 md:px-5 md:py-6">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <ScanEye className="size-4" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">AE 工作台</div>
          <div className="hidden text-xs text-muted-foreground md:block">技术支持 · 需求沉淀</div>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:px-3 md:pb-0">
        {ITEMS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
              active(href)
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  )
}
