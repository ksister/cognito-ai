import Link from "next/link"
import { notFound } from "next/navigation"
import { ChevronLeft, PenLine } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState, PageHeader, StatusBadge, recordHref } from "@/components/bits"
import { CopyContextButton, FilesPanel, ProfileEditor } from "@/components/customer-panels"
import { ShotThumbs } from "@/components/shot-thumbs"
import { getProfile, listCustomerNames, listFiles, listRecords } from "@/lib/kb"
import { OPEN_STATUSES, type CustomerProfile, type SupportRecord } from "@/lib/types"

export const dynamic = "force-dynamic"

function contextForAi(p: CustomerProfile, records: SupportRecord[]) {
  const lines = [
    `# 客户：${p.name}`,
    `阶段：${p.stage || "未知"}；行业/场景：${p.industry || "未知"}；软件：${p.products || "未知"}；硬件：${p.hardware || "未知"}；联系人：${p.contacts || "未知"}`,
    p.notes ? `备注：${p.notes}` : "",
    "",
    `## 技术支持时间线（共 ${records.length} 条，按时间正序）`,
  ]
  for (const r of records) {
    lines.push(
      "",
      `### ${r.date} ${r.title}（${r.category}｜${r.module || "未标模块"}｜${r.status}）`,
      `问题：${r.problem}`,
      `过程：${r.process}`,
      `结论：${r.solution}`,
      r.thoughts ? `我的思考：${r.thoughts}` : "",
      r.needs.length ? `需求线索：${r.needs.map((n) => n.pain + (n.idea ? `→${n.idea}` : "")).join("；")}` : "",
    )
  }
  lines.push(
    "",
    "---",
    "请基于以上资料：1) 总结这个客户的整体情况与支持历程；2) 找出反复出现的问题和根因；3) 提炼对我们视觉软件的改进需求；4) 给出下一步跟进建议。",
  )
  return lines.filter((l) => l !== "").join("\n")
}

export default async function CustomerPage({ params }: PageProps<"/customers/[name]">) {
  const name = decodeURIComponent((await params).name)
  if (!(await listCustomerNames()).includes(name)) notFound()
  const [profile, records, files] = await Promise.all([getProfile(name), listRecords(name), listFiles(name)])
  const timeline = [...records].sort((a, b) => (a.date + a.created).localeCompare(b.date + b.created))
  const linked = new Set(records.flatMap((r) => r.screenshots))
  const unlinked = files.filter((f) => !linked.has(f.name))
  const open = records.filter((r) => OPEN_STATUSES.includes(r.status)).length
  const modules = Object.entries(
    records.reduce<Record<string, number>>((m, r) => ((m[r.module || "未标注"] = (m[r.module || "未标注"] ?? 0) + 1), m), {}),
  ).sort((a, b) => b[1] - a[1])

  return (
    <>
      <Link href="/customers" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" />
        全部客户
      </Link>
      <PageHeader
        title={name}
        description={
          timeline.length
            ? `${timeline[0].date} 首次支持 · 共 ${records.length} 次 · ${open} 个未结`
            : "还没有支持记录"
        }
      >
        <CopyContextButton text={contextForAi(profile, timeline)} />
        <a
          href={`/api/export?customer=${encodeURIComponent(name)}`}
          className="inline-flex h-8 items-center rounded-lg border bg-background px-2.5 text-sm font-medium hover:bg-muted"
        >
          导出 CSV
        </a>
        <Link
          href={`/new?customer=${encodeURIComponent(name)}`}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/80"
        >
          <PenLine className="size-4" />
          记一笔
        </Link>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">支持时间线 · 从头到尾</h2>
          {timeline.length === 0 ? (
            <EmptyState title="暂无记录" action={{ href: `/new?customer=${encodeURIComponent(name)}`, label: "记一笔" }} />
          ) : (
            <ol className="relative space-y-4 border-l-2 border-primary/20 pl-6">
              {timeline.map((r) => (
                <li key={r.id} className="relative">
                  <span
                    className={`absolute top-5 -left-[31px] size-3 rounded-full ring-4 ring-muted ${
                      OPEN_STATUSES.includes(r.status) ? "bg-amber-500" : "bg-primary"
                    }`}
                  />
                  <Card size="sm">
                    <CardContent className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground tabular-nums">{r.date}</span>
                        <Badge variant="outline">{r.category}</Badge>
                        {r.module && <Badge variant="secondary">{r.module}</Badge>}
                        <span className="ml-auto">
                          <StatusBadge status={r.status} />
                        </span>
                      </div>
                      <Link href={recordHref(r)} className="block font-medium hover:text-primary">
                        {r.title}
                      </Link>
                      {r.screenshots.length > 0 && <ShotThumbs customer={name} names={r.screenshots} size="sm" />}
                      {r.problem && <p className="line-clamp-2 text-sm text-muted-foreground">{r.problem}</p>}
                      {r.solution && (
                        <p className="line-clamp-2 text-sm">
                          <span className="text-muted-foreground">结论：</span>
                          {r.solution}
                        </p>
                      )}
                      {r.thoughts && (
                        <p className="line-clamp-3 rounded-lg bg-primary/5 px-2.5 py-1.5 text-sm whitespace-pre-wrap">
                          <span className="font-medium text-primary">我的思考：</span>
                          {r.thoughts}
                        </p>
                      )}
                      {r.needs.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {r.needs.map((n, i) => (
                            <Badge key={i} variant="outline" className="h-auto max-w-full border-primary/30 py-0.5 whitespace-normal text-primary">
                              需求：{n.pain.slice(0, 40)}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>客户档案</CardTitle>
            </CardHeader>
            <CardContent>
              <ProfileEditor profile={profile} />
            </CardContent>
          </Card>
          {modules.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>问题集中在</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {modules.map(([m, n]) => (
                  <div key={m} className="flex items-center gap-2 text-sm">
                    <span className="w-20 shrink-0 truncate">{m}</span>
                    <div className="h-2 flex-1 rounded-full bg-muted">
                      <div className="h-2 rounded-full bg-primary" style={{ width: `${(n / records.length) * 100}%` }} />
                    </div>
                    <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{n}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>未关联资料</CardTitle>
            </CardHeader>
            <CardContent>
              <FilesPanel
                customer={name}
                files={unlinked}
                empty="没有未关联的资料。记录里的截图显示在时间线上；其它文件可拖到这里，不会被删除。"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
