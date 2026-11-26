import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import type { BubbleItem } from "@/lib/chat-bubble-view"

/**
 * T27 PR-B：通用聊天气泡（纯显示）。T29「模拟问答」复用同一套气泡，
 * 交互部分（标错、打分、输入框）通过 `renderActions` 插槽传进来，不写死在这个组件里。
 */
export type ChatBubblesProps = {
  items: BubbleItem[]
  /** 「只看『我』」：非我的气泡淡化。 */
  dimOthers?: boolean
  /** 对比另一次运行时，发言人不同的行 → 黄色描边。 */
  isSpeakerDiff?: (item: BubbleItem) => boolean
  /** 点击气泡（打开操作面板）。 */
  onBubbleClick?: (item: BubbleItem) => void
  /** 点击气泡下方的引用灰字（用来标「不是引用」）。 */
  onQuoteClick?: (item: BubbleItem) => void
  /** 交互区插槽：操作面板、打分、输入框等。 */
  renderActions?: (item: BubbleItem) => ReactNode
  /** 需要高亮滚动到的行（点顶部「待核对」时用）。 */
  activeLine?: number | null
  className?: string
}

const MEDIA_LABEL: Record<string, string> = { "[图片]": "图片", "[文件]": "文件", "[表情]": "表情" }

function mediaToken(text: string): string | null {
  for (const token of Object.keys(MEDIA_LABEL)) {
    if (text.trim().startsWith(token)) return token
  }
  return null
}

function BubbleBody({ item }: { item: BubbleItem }) {
  const token = mediaToken(item.displayText)
  if (token) {
    const rest = item.displayText.trim().slice(token.length).trim()
    return (
      <div className="flex items-center gap-2 rounded-md border bg-background/70 px-2 py-1.5 text-xs">
        <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{MEDIA_LABEL[token]}</span>
        <span className="min-w-0 break-all text-muted-foreground">{rest || "（无标题）"}</span>
      </div>
    )
  }
  return <div className="whitespace-pre-wrap break-words">{item.displayText}</div>
}

function QuoteLine({ item, onClick }: { item: BubbleItem; onClick?: (item: BubbleItem) => void }) {
  if (!item.quote && !item.replyUnsplit) return null
  const label = item.quote ? `引用 ${item.quote.name}：${item.quote.text}` : "回复：拆不出引用的原文"
  const missing = (item.quote && !item.quoteVerified) || item.replyUnsplit
  const reason = item.replyUnsplit ? "回复拆不出引用" : "引用找不到原话"
  return (
    <button
      type="button"
      onClick={() => onClick?.(item)}
      title="点一下可以标「不是引用」"
      className={cn(
        "mt-1 block w-full rounded border-l-2 px-1.5 py-0.5 text-left text-[11px] leading-snug",
        onClick && "hover:bg-muted",
        missing
          ? "border-amber-500 bg-amber-50 text-amber-800"
          : "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
      )}
    >
      <span className="line-clamp-2 break-words">{label}</span>
      {missing && <span className="ml-1 rounded bg-amber-200 px-1 text-[10px] font-medium text-amber-900">{reason}</span>}
    </button>
  )
}

/** 消息列表：右侧绿色=我，左侧白色=客户，左侧带「同事」标签=我方同事，时间和系统提示居中灰字。 */
export function ChatBubbles({
  items,
  dimOthers,
  isSpeakerDiff,
  onBubbleClick,
  onQuoteClick,
  renderActions,
  activeLine,
  className,
}: ChatBubblesProps) {
  return (
    <div className={cn("space-y-2", className)}>
      {items.map((item, idx) => {
        if (item.kind === "time" || item.variant === "system") {
          return (
            <div key={`${item.line}-${idx}`} className="py-1 text-center text-[11px] text-muted-foreground">
              {item.displayText}
            </div>
          )
        }
        const isMe = item.variant === "me"
        const dim = dimOthers && !isMe
        const marked = item.markedTypes.length > 0
        const pending = (item.quote && !item.quoteVerified) || item.replyUnsplit
        return (
          <div
            key={`${item.line}-${idx}`}
            id={item.line ? `chat-line-${item.line}` : undefined}
            className={cn("space-y-1", dim && "opacity-40")}
          >
            <div className={cn("flex items-end gap-1", isMe ? "flex-row-reverse" : "flex-row")}>
              <div className={cn("flex min-w-0 max-w-[92%] flex-col gap-0.5", isMe ? "items-end" : "items-start")}>
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="font-medium">{item.displaySpeaker || "未知"}</span>
                  {item.variant === "colleague" && (
                    <span className="rounded bg-sky-100 px-1 text-[10px] text-sky-700">同事</span>
                  )}
                </div>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => onBubbleClick?.(item)}
                    title={marked ? `原来是：${item.originalSpeaker}：${item.originalText}` : undefined}
                    className={cn(
                      "relative block rounded-2xl px-2.5 py-1.5 text-left text-xs leading-relaxed shadow-sm transition",
                      isMe ? "bg-emerald-500 text-white" : "border bg-card text-foreground hover:border-foreground/30",
                      isSpeakerDiff?.(item) && "ring-2 ring-amber-400",
                      pending && "ring-2 ring-amber-500",
                      activeLine === item.line && "ring-2 ring-sky-500",
                      onBubbleClick && "cursor-pointer",
                    )}
                  >
                    <BubbleBody item={item} />
                    {marked && (
                      <span className="absolute -top-1 -right-1 size-2 rounded-full bg-red-500 ring-2 ring-background" />
                    )}
                  </button>
                  <QuoteLine item={item} onClick={onQuoteClick} />
                </div>
                {renderActions?.(item)}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
