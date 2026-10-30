import { notFound } from "next/navigation"
import { PageHeader } from "@/components/bits"
import { RecordForm } from "@/components/record-form"
import { aiLabel } from "@/lib/ai"
import { loadFeishuSchemaState } from "@/lib/feishu-schema-load"
import { getRecord, listCustomerNames, listSiteSuggestions } from "@/lib/kb"

export const dynamic = "force-dynamic"

export default async function EditRecordPage({ params }: PageProps<"/records/[customer]/[file]/edit">) {
  const { customer, file } = await params
  const r = await getRecord(decodeURIComponent(customer), decodeURIComponent(file))
  if (!r) notFound()
  return (
    <>
      <PageHeader title="编辑记录" description={`${r.customer} · ${r.date}`} />
      <RecordForm
        customers={await listCustomerNames()}
        aiLabel={aiLabel()}
        initial={r}
        schemaState={await loadFeishuSchemaState()}
        siteSuggestions={await listSiteSuggestions()}
      />
    </>
  )
}
