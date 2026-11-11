import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/bits"
import { PasteViewPicker } from "@/components/paste-view-picker"
import { loadPasteViewSetting } from "@/lib/paste-view-config"

export const dynamic = "force-dynamic"

export default async function SettingsPage() {
  const setting = await loadPasteViewSetting()

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
              「复制为飞书行」按这个视图的可见列顺序生成一行：工作台不填的列（公式、创建人、附件、人员等）输出空占位，
              视图隐藏、但工作台会填的列会在复制时提示。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PasteViewPicker initialViewName={setting?.viewName ?? null} />
          </CardContent>
        </Card>
      </section>
    </>
  )
}
