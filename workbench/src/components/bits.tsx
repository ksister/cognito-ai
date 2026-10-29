import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Status } from "@/lib/types"

const STATUS_STYLE: Record<Status, string> = {
  待处理: "bg-red-50 text-red-700 border-red-200",
  跟进中: "bg-amber-50 text-amber-700 border-amber-200",
  已解决: "bg-emerald-50 text-emerald-700 border-emerald-200",
  已关闭: "bg-zinc-100 text-zinc-600 border-zinc-200",
}

export function StatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant="outline" className={STATUS_STYLE[status]}>
      {status}
    </Badge>
  )
}

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: React.ReactNode
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: { href: string; label: string }
}) {
  return (
    <div className="rounded-xl border border-dashed bg-background px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && (
        <Link
          href={action.href}
          className="mt-4 inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80"
        >
          {action.label}
        </Link>
      )}
    </div>
  )
}

export function recordHref(r: { customer: string; file: string }) {
  return `/records/${encodeURIComponent(r.customer)}/${encodeURIComponent(r.file.replace(/\.md$/, ""))}`
}

export function customerHref(name: string) {
  return `/customers/${encodeURIComponent(name)}`
}

export const selectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"

export function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-1.5", className)}>
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

export function Prose({ text, empty = "—" }: { text: string; empty?: string }) {
  return text.trim() ? (
    <div className="text-sm leading-relaxed whitespace-pre-wrap">{text}</div>
  ) : (
    <div className="text-sm text-muted-foreground">{empty}</div>
  )
}
