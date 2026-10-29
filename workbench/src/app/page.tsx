import Link from "next/link"
import { ArrowRight, PenLine } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState, PageHeader, StatusBadge, customerHref, recordHref } from "@/components/bits"
import { SyncPanel } from "@/components/record-actions"
import { aiConfigured } from "@/lib/ai"
import { listCustomerNames, listRecords } from "@/lib/kb"
import { OPEN_STATUSES, localDate } from "@/lib/types"

export const dynamic = "force-dynamic"

function daysAgo(n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDate(d)
}

export default async function Dashboard() {
  const [records, customers] = await Promise.all([listRecords(), listCustomerNames()])
  const weekAgo = daysAgo(6)
  const thisWeek = records.filter((r) => r.date >= weekAgo)
  const open = records.filter((r) => OPEN_STATUSES.includes(r.status))
  const unsynced = records.filter((r) => !r.feishuSynced)
  const needCount = records.reduce((n, r) => n + r.needs.length, 0)

  const stats = [
    { label: "近 7 天支持", value: thisWeek.length, href: "/records" },
    { label: "未结问题", value: open.length, href: "/records?status=open" },
    { label: "客户", value: customers.length, href: "/customers" },
    { label: "需求线索", value: needCount, href: "/requirements" },
  ]

  return (
    <>
      <PageHeader title="工作台" description="今天的支持，先记一笔；飞书表格、客户时间线、需求池都从这里自动生成。">
        <Link
          href="/new"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80"
        >
          <PenLine className="size-4" />
          记一笔
        </Link>
      </PageHeader>

      {!aiConfigured() && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          还没有配置 AI 模型，目前用规则做初步提取。在 <code className="font-mono">workbench/.env.local</code> 中填写{" "}
          <code className="font-mono">AI_API_KEY</code> 即可启用（支持 DeepSeek、通义千问等 OpenAI 兼容接口，见 README）。
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href}>
            <Card size="sm" className="transition-shadow hover:shadow-md">
              <CardContent>
                <div className="text-xs text-muted-foreground">{s.label}</div>
                <div className="mt-1 text-3xl font-semibold tabular-nums">{s.value}</div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>最近的支持</CardTitle>
            <CardDescription>按日期倒序</CardDescription>
          </CardHeader>
          <CardContent>
            {records.length === 0 ? (
              <EmptyState
                title="还没有支持记录"
                description="把今天和客户的聊天记录粘贴进来，AI 会帮你整理成一条结构化记录。"
                action={{ href: "/new", label: "记第一笔" }}
              />
            ) : (
              <ul className="divide-y">
                {records.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-2.5">
                    <span className="w-20 shrink-0 text-xs text-muted-foreground tabular-nums">{r.date}</span>
                    <div className="min-w-0 flex-1">
                      <Link href={recordHref(r)} className="block truncate text-sm font-medium hover:text-primary">
                        {r.title}
                      </Link>
                      <Link href={customerHref(r.customer)} className="text-xs text-muted-foreground hover:underline">
                        {r.customer}
                        {r.module && ` · ${r.module}`}
                      </Link>
                    </div>
                    <StatusBadge status={r.status} />
                  </li>
                ))}
              </ul>
            )}
            {records.length > 8 && (
              <Link href="/records" className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline">
                查看全部 <ArrowRight className="size-3.5" />
              </Link>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>同步到飞书表格</CardTitle>
              <CardDescription>不用再一条条手填</CardDescription>
            </CardHeader>
            <CardContent>
              <SyncPanel records={unsynced} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>未结问题</CardTitle>
              <CardDescription>待处理 + 跟进中</CardDescription>
            </CardHeader>
            <CardContent>
              {open.length === 0 ? (
                <p className="text-sm text-muted-foreground">没有未结问题。</p>
              ) : (
                <ul className="space-y-2">
                  {open.slice(0, 6).map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2">
                      <Link href={recordHref(r)} className="min-w-0 truncate text-sm hover:text-primary">
                        <span className="text-muted-foreground">{r.customer} · </span>
                        {r.title}
                      </Link>
                      <StatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
