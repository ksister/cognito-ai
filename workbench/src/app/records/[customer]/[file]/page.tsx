import Link from "next/link"
import { notFound } from "next/navigation"
import { AlertTriangle, ChevronLeft, Pencil } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader, Prose, Section, customerHref, recordHref } from "@/components/bits"
import { CopyFeishuButton, StatusSelect } from "@/components/record-actions"
import { ShotThumbs } from "@/components/shot-thumbs"
import { getRecord } from "@/lib/kb"

export const dynamic = "force-dynamic"

export default async function RecordPage({ params }: PageProps<"/records/[customer]/[file]">) {
  const { customer, file } = await params
  const r = await getRecord(decodeURIComponent(customer), decodeURIComponent(file))
  if (!r) notFound()

  const meta = [
    ["日期", r.date],
    ["联系人", r.contact],
    ["渠道", r.channel],
    ["产品/版本", r.product],
    ["模块", r.module],
    ["分类", r.category],
  ]

  return (
    <>
      <Link href={customerHref(r.customer)} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" />
        {r.customer} 的时间线
      </Link>
      <PageHeader title={r.title}>
        <StatusSelect record={r} />
        <CopyFeishuButton record={r} />
        <Link
          href={`${recordHref(r)}/edit`}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-sm font-medium hover:bg-muted"
        >
          <Pencil className="size-4" />
          编辑
        </Link>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          {r.screenshots.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>截图</CardTitle>
              </CardHeader>
              <CardContent>
                <ShotThumbs customer={r.customer} names={r.screenshots} />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="space-y-5">
              <Section title="问题描述">
                <Prose text={r.problem} />
              </Section>
              <Section title="处理过程">
                <Prose text={r.process} />
              </Section>
              <Section title="解决方案 / 当前结论">
                <Prose text={r.solution} />
              </Section>
            </CardContent>
          </Card>

          <Card className="border-primary/30 bg-primary/[0.03] ring-primary/20">
            <CardHeader>
              <CardTitle>我的思考</CardTitle>
            </CardHeader>
            <CardContent>
              <Prose text={r.thoughts} empty="还没写。编辑时补几句你的判断，以后回看最有价值。" />
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <details>
                <summary className="cursor-pointer text-sm font-medium">原始聊天记录（备份）</summary>
                <pre className="mt-3 max-h-[32rem] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                  {r.chat || "（无）"}
                </pre>
              </details>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardContent>
              <dl className="grid grid-cols-[5rem_1fr] gap-y-2 text-sm">
                {meta.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd>{v || "—"}</dd>
                  </div>
                ))}
                <dt className="text-muted-foreground">飞书</dt>
                <dd>{r.feishuSynced ? "已同步" : "未同步"}</dd>
              </dl>
            </CardContent>
          </Card>

          {r.uncertain.length > 0 && (
            <Card className="border-amber-300 bg-amber-50/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-amber-900">
                  <AlertTriangle className="size-4" />
                  待确认
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="list-disc space-y-1 pl-4 text-sm text-amber-900">
                  {r.uncertain.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>需求线索</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {r.needs.length === 0 ? (
                <p className="text-sm text-muted-foreground">无</p>
              ) : (
                r.needs.map((n, i) => (
                  <div key={i} className="space-y-1 rounded-lg border p-3 text-sm">
                    <Badge variant="outline">{n.type}</Badge>
                    <p>{n.pain}</p>
                    {n.idea && <p className="text-muted-foreground">→ {n.idea}</p>}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <p className="text-xs break-all text-muted-foreground">
            文件：customers/{r.customer}/records/{r.file}
          </p>
        </div>
      </div>
    </>
  )
}
