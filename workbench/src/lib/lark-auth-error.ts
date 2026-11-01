/** T10：识别 lark-cli 登录过期/失效的错误，给出重新登录引导。 */
export function larkAuthExpiryMessage(err: {
  type?: string
  subtype?: string
  message?: string
  hint?: string
}): string | null {
  const text = `${err.type ?? ""} ${err.subtype ?? ""} ${err.message ?? ""} ${err.hint ?? ""}`.toLowerCase()
  if (/expire|refresh.?token|登录.?过期|登录.?失效/i.test(text)) {
    return "飞书登录已过期或失效（个人身份 token 有效期约 2 小时）。请在本机运行 lark-cli auth login 重新登录。本地记录已保存，可先用「复制为飞书行」兜底。"
  }
  return null
}
