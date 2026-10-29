import { PageHeader } from "@/components/bits"
import { RecordForm } from "@/components/record-form"
import { aiLabel } from "@/lib/ai"
import { listCustomerNames } from "@/lib/kb"

export const dynamic = "force-dynamic"

export default async function NewRecordPage({ searchParams }: PageProps<"/new">) {
  const { customer } = await searchParams
  return (
    <>
      <PageHeader title="记一笔" description="粘贴聊天记录 → AI 整理 → 你来核对并补充思考 → 一键保存。" />
      <RecordForm
        customers={await listCustomerNames()}
        aiLabel={aiLabel()}
        defaultCustomer={typeof customer === "string" ? customer : undefined}
      />
    </>
  )
}
