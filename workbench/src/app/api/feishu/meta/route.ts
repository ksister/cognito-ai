import { getLarkMeta } from "@/lib/lark-bitable"

export async function GET() {
  try {
    const meta = await getLarkMeta()
    return Response.json(meta)
  } catch (e) {
    return Response.json(
      {
        configured: false,
        error: (e as Error).message,
        options: {
          company: [],
          status: [],
          product: [],
          resolveMethod: [],
          supportType: [],
          site: [],
        },
        handlers: [],
      },
      { status: 200 },
    )
  }
}
