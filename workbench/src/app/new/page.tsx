import { PageHeader } from "@/components/bits"
import { RecordForm } from "@/components/record-form"
import { aiLabel } from "@/lib/ai"
import { loadFeishuSchemaState } from "@/lib/feishu-schema-load"
import { vlLabel } from "@/lib/vl"
import { listCustomerNames, listSiteSuggestions } from "@/lib/kb"

export const dynamic = "force-dynamic"

export default async function NewRecordPage({ searchParams }: PageProps<"/new">) {
  const { customer } = await searchParams
  return (
    <>
      <PageHeader
        title="记一笔"
        description="上传微信/飞书聊天截图 → 通义 VL 整理 → 黄区核对 → 确认保存（原文图备份到客户目录）。也可粘贴文字。"
      />
      <RecordForm
        customers={await listCustomerNames()}
        aiLabel={aiLabel()}
        vlLabel={vlLabel()}
        defaultCustomer={typeof customer === "string" ? customer : undefined}
        schemaState={await loadFeishuSchemaState()}
        siteSuggestions={await listSiteSuggestions()}
      />
    </>
  )
}
