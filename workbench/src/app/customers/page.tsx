import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState, PageHeader, customerHref } from "@/components/bits"
import { listCustomers } from "@/lib/kb"

export const dynamic = "force-dynamic"

export default async function CustomersPage() {
  const customers = await listCustomers()
  return (
    <>
      <PageHeader title="客户" description="保存支持记录时会自动建立客户档案。点进去看从第一次接触到现在的完整过程。" />
      {customers.length === 0 ? (
        <EmptyState title="还没有客户" description="记第一笔支持记录时填写客户名，就会自动出现在这里。" action={{ href: "/new", label: "记一笔" }} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {customers.map((c) => (
            <Link key={c.name} href={customerHref(c.name)}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{c.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{c.industry || "未填写行业/场景"}</div>
                    </div>
                    {c.stage && <Badge variant="secondary">{c.stage}</Badge>}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <Stat label="支持" value={c.recordCount} />
                    <Stat label="未结" value={c.openCount} warn={c.openCount > 0} />
                    <Stat label="需求" value={c.needCount} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {c.firstDate ? `${c.firstDate} → ${c.lastDate}` : "暂无记录"}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-lg bg-muted/60 py-1.5">
      <div className={`text-lg font-semibold tabular-nums ${warn ? "text-amber-600" : ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}
