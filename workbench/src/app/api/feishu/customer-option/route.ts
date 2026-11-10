import { addCustomerOption } from "@/lib/lark-bitable"

export async function POST(req: Request) {
  let name = ""
  try {
    const body = (await req.json()) as { name?: string }
    name = String(body.name ?? "")
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 })
  }
  const result = await addCustomerOption(name)
  if ("error" in result) {
    return Response.json(result, { status: 400 })
  }
  return Response.json(result)
}
