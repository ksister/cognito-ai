import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/bits"
import { NicknameEditor } from "@/components/nickname-editor"
import { PasteViewPicker, type PickerState } from "@/components/paste-view-picker"
import { SpeakersEditor } from "@/components/speakers-editor"
import { resolveKbRoot } from "@/lib/feishu-schema-load"
import { listFeishuViews } from "@/lib/lark-view"
import { buildPasteViewState } from "@/lib/paste-view-state"
import { loadReplaySettings } from "@/lib/replay-config"
import { loadSpeakersSettings } from "@/lib/speakers-config"

export const dynamic = "force-dynamic"

export default async function SettingsPage() {
  const [listed, state, speakers, replay] = await Promise.all([
    listFeishuViews(),
    buildPasteViewState(),
    loadSpeakersSettings(resolveKbRoot()),
    loadReplaySettings(resolveKbRoot()),
  ])
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
        description="这台电脑专用的配置。真实视图、客户、昵称和令牌只存在 KB_DIR 的私有文件里，不进仓库。"
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

      <section className="mt-6 space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">发言人</h2>
        <Card>
          <CardHeader>
            <CardTitle>我的昵称和我方公司名前缀</CardTitle>
            <CardDescription>
              判断聊天截图里哪边是你、哪边是客户。重新识别（「从截图重新转写」）和主流程转写都用这一份设置，
              存在 KB_DIR 的 config/speakers.json，不进仓库。
            </CardDescription>
          </CardHeader>
          <CardContent>
            {speakers.ok ? (
              <SpeakersEditor
                initialNicknames={speakers.settings.myNicknames}
                initialPrefixes={speakers.settings.companyPrefixes}
                fromLegacy={speakers.source === "replay"}
              />
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-destructive">{speakers.error}</p>
                {replay.ok && replay.settings.myNicknames.length > 0 && (
                  <>
                    <p className="text-xs text-muted-foreground">旧配置里的昵称还在，可以先用着；保存一次就会写到新文件。</p>
                    <NicknameEditor initial={replay.settings.myNicknames} />
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </>
  )
}
