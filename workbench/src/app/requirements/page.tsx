import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AnalyzeButton } from "@/components/analyze-button"
import { EmptyState, PageHeader, customerHref, recordHref } from "@/components/bits"
import { listRecords, listRequirementDocs } from "@/lib/kb"
import { NEED_TYPES } from "@/lib/types"

export const dynamic = "force-dynamic"

export default async function RequirementsPage({ searchParams }: PageProps<"/requirements">) {
  const sp = await searchParams
  const type = typeof sp.type === "string" ? sp.type : ""
  const [records, docs] = await Promise.all([listRecords(), listRequirementDocs()])

  const rows = records.flatMap((r) => r.needs.map((n, i) => ({ ...n, record: r, key: `${r.id}#${i}` })))
  const filtered = type ? rows.filter((r) => r.type === type) : rows
  const groups = new Map<string, typeof rows>()
  for (const row of filtered) {
    const k = row.record.module || "未标注模块"
    groups.set(k, [...(groups.get(k) ?? []), row])
  }
  const sorted = [...groups.entries()]
    .map(([mod, items]) => ({ mod, items, customers: new Set(items.map((i) => i.record.customer)) }))
    .sort((a, b) => b.customers.size - a.customers.size || b.items.length - a.items.length)

  const selected = typeof sp.doc === "string" ? docs.find((d) => d.file === sp.doc) : docs[0]

  return (
    <>
      <PageHeader
        title="需求池"
        description="每条支持记录里的痛点都汇总在这里。按影响客户数排序，越靠前越值得推动研发。"
      >
        <AnalyzeButton disabled={rows.length === 0} />
      </PageHeader>

      <div className="mb-4 flex flex-wrap gap-1.5">
        <FilterChip href="/requirements" active={!type} label={`全部 ${rows.length}`} />
        {NEED_TYPES.map((t) => (
          <FilterChip
            key={t}
            href={`/requirements?type=${encodeURIComponent(t)}`}
            active={type === t}
            label={`${t} ${rows.filter((r) => r.type === t).length}`}
          />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          {rows.length === 0 ? (
            <EmptyState
              title="需求池还是空的"
              description="整理支持记录时，AI 会从客户的抱怨和「能不能…」里提炼需求线索；你也可以在记录里手动添加。"
              action={{ href: "/new", label: "记一笔" }}
            />
          ) : (
            sorted.map((g) => (
              <Card key={g.mod}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {g.mod}
                    <Badge variant="secondary">
                      {g.customers.size} 家客户 · {g.items.length} 条
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y">
                    {g.items.map((n) => (
                      <li key={n.key} className="space-y-1 py-2.5 first:pt-0 last:pb-0">
                        <p className="text-sm">{n.pain}</p>
                        {n.idea && <p className="text-sm text-primary">→ {n.idea}</p>}
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <Badge variant="outline">{n.type}</Badge>
                          <Link href={customerHref(n.record.customer)} className="hover:underline">
                            {n.record.customer}
                          </Link>
                          <span>·</span>
                          <Link href={recordHref(n.record)} className="hover:underline">
                            {n.record.date} {n.record.title}
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        <Card className="h-fit lg:sticky lg:top-8">
          <CardHeader>
            <CardTitle>需求分析文档</CardTitle>
            <CardDescription>点「生成需求分析」，AI 会聚类线索、评估优先级，保存到 requirements/ 目录，可直接改写后提交研发。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {docs.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有生成过。</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {docs.map((d) => (
                    <FilterChip
                      key={d.file}
                      href={`/requirements?doc=${encodeURIComponent(d.file)}${type ? `&type=${encodeURIComponent(type)}` : ""}`}
                      active={selected?.file === d.file}
                      label={d.file.replace(/\.md$/, "")}
                    />
                  ))}
                </div>
                {selected && (
                  <div className="max-h-[36rem] overflow-auto rounded-lg bg-muted p-3 text-sm leading-relaxed whitespace-pre-wrap">
                    {selected.content}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted"
      }`}
    >
      {label}
    </Link>
  )
}
