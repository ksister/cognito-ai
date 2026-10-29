import Link from "next/link"
import { Search } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { EmptyState, PageHeader, StatusBadge, customerHref, recordHref, selectClass } from "@/components/bits"
import { listCustomerNames, listRecords } from "@/lib/kb"
import { CATEGORIES, OPEN_STATUSES, STATUSES } from "@/lib/types"

export const dynamic = "force-dynamic"

export default async function RecordsPage({ searchParams }: PageProps<"/records">) {
  const sp = await searchParams
  const q = typeof sp.q === "string" ? sp.q.trim() : ""
  const customer = typeof sp.customer === "string" ? sp.customer : ""
  const status = typeof sp.status === "string" ? sp.status : ""
  const category = typeof sp.category === "string" ? sp.category : ""

  const [all, customers] = await Promise.all([listRecords(), listCustomerNames()])
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  const records = all.filter((r) => {
    if (customer && r.customer !== customer) return false
    if (status === "open" && !OPEN_STATUSES.includes(r.status)) return false
    if (status && status !== "open" && r.status !== status) return false
    if (category && r.category !== category) return false
    if (terms.length) {
      const hay = [r.title, r.customer, r.problem, r.process, r.solution, r.thoughts, r.module, r.product, r.chat]
        .join("\n")
        .toLowerCase()
      return terms.every((t) => hay.includes(t))
    }
    return true
  })

  return (
    <>
      <PageHeader title="支持记录" description="全文搜索包含聊天原文和你的思考。">
        <a href="/api/export" className="inline-flex h-8 items-center rounded-lg border bg-background px-2.5 text-sm font-medium hover:bg-muted">
          导出全部 CSV
        </a>
      </PageHeader>

      <form className="mb-4 grid gap-2 sm:grid-cols-[1fr_10rem_8rem_8rem_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
          <Input name="q" defaultValue={q} placeholder="搜索：曝光、标定、报错码、客户名…" className="bg-background pl-8" />
        </div>
        <select name="customer" defaultValue={customer} className={`${selectClass} bg-background`}>
          <option value="">全部客户</option>
          {customers.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select name="status" defaultValue={status} className={`${selectClass} bg-background`}>
          <option value="">全部状态</option>
          <option value="open">未结</option>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select name="category" defaultValue={category} className={`${selectClass} bg-background`}>
          <option value="">全部分类</option>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <button className="h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80">筛选</button>
      </form>

      {records.length === 0 ? (
        all.length === 0 ? (
          <EmptyState title="还没有支持记录" description="从「记一笔」开始。" action={{ href: "/new", label: "记一笔" }} />
        ) : (
          <EmptyState title="没有符合条件的记录" description="换个关键词或清除筛选试试。" action={{ href: "/records", label: "清除筛选" }} />
        )
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <ul className="divide-y">
              {records.map((r) => (
                <li key={r.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground tabular-nums">{r.date}</span>
                  <div className="min-w-0 flex-1">
                    <Link href={recordHref(r)} className="block truncate font-medium hover:text-primary">
                      {r.title}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">{r.problem.split("\n")[0]}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Link href={customerHref(r.customer)}>
                      <Badge variant="secondary">{r.customer}</Badge>
                    </Link>
                    <Badge variant="outline">{r.category}</Badge>
                    {r.needs.length > 0 && <Badge variant="outline" className="border-primary/30 text-primary">需求 {r.needs.length}</Badge>}
                    {!r.feishuSynced && <Badge variant="outline" className="text-muted-foreground">未同步</Badge>}
                    <StatusBadge status={r.status} />
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  )
}
