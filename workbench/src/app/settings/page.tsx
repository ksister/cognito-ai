import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/bits"
import { PasteViewPicker, type PickerState } from "@/components/paste-view-picker"
import { listFeishuViews } from "@/lib/lark-view"
import { buildPasteViewState } from "@/lib/paste-view-state"

export const dynamic = "force-dynamic"

export default async function SettingsPage() {
  const [listed, state] = await Promise.all([listFeishuViews(), buildPasteViewState()])
  const views = listed.ok ? listed.views.map((v) => ({ name: v.name, columnCount: v.columnCount })) : []
  const initial: PickerState = {
    configured: state.configured,
    broken: state.broken,
    source: state.source,
    viewName: state.viewName,
    columns: state.columns,
    placeholders: state.placeholders,
    hidden: state.hidden,
    readAt: state.readAt,
    error: state.error,
  }

  return (
    <>
      <PageHeader
        title="设置"
        description="这台电脑专用的配置。真实视图、客户和令牌只存在 KB_DIR 的私有文件里，不进仓库。"
      />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">飞书</h2>
        <Card>
          <CardHeader>
            <CardTitle>粘贴用的视图</CardTitle>
            <CardDescription>
              「复制为飞书行」按这个视图的可见列顺序生成一行：工作台不填的列（公式、创建人、附件、人员等）输出空占位；
              视图隐藏、但工作台会填的列会在复制时提示。每次读到列序都会存一份缓存，飞书暂时读不到时按缓存复制。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PasteViewPicker
              views={views}
              viewError={listed.ok ? null : listed.error}
              initialViewName={state.viewName}
              initialState={initial}
            />
          </CardContent>
        </Card>
      </section>
    </>
  )
}
