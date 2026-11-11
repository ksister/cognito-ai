import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/bits"
import { PasteViewPicker, type PickerState } from "@/components/paste-view-picker"
import { loadFeishuSchemaState } from "@/lib/feishu-schema-load"
import { listFeishuViews, readFeishuViewColumns } from "@/lib/lark-view"
import { hiddenSchemaColumns, placeholderViewColumns, viewColumnNames } from "@/lib/paste-view"
import { loadPasteViewSetting } from "@/lib/paste-view-config"

export const dynamic = "force-dynamic"

export default async function SettingsPage() {
  const setting = await loadPasteViewSetting()
  const listed = await listFeishuViews()
  const views = listed.ok ? listed.views.map((v) => ({ name: v.name, columnCount: v.columnCount })) : []

  let state: PickerState | null = null
  if (setting) {
    const [read, schemaState] = await Promise.all([
      readFeishuViewColumns(setting.viewId || setting.viewName),
      loadFeishuSchemaState(),
    ])
    if (read.ok && schemaState.ok) {
      const columns = viewColumnNames(read.columns)
      state = {
        readable: true,
        viewName: setting.viewName,
        columns,
        placeholders: placeholderViewColumns(columns, schemaState.schema),
        hidden: hiddenSchemaColumns(columns, schemaState.schema),
      }
    } else {
      let error = ""
      if (!read.ok) error = read.error
      else if (!schemaState.ok) error = schemaState.error
      state = {
        readable: false,
        viewName: setting.viewName,
        columns: [],
        placeholders: [],
        hidden: [],
        error,
      }
    }
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
              视图隐藏、但工作台会填的列会在复制时提示。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PasteViewPicker
              views={views}
              viewError={listed.ok ? null : listed.error}
              initialViewName={setting?.viewName ?? null}
              initialState={state}
            />
          </CardContent>
        </Card>
      </section>
    </>
  )
}
