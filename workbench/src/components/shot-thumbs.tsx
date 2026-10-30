export function ShotThumbs({
  customer,
  names,
  size = "md",
}: {
  customer: string
  names: string[]
  size?: "sm" | "md"
}) {
  if (!names.length) return null
  const height = size === "sm" ? "h-16" : "h-28"
  return (
    <div className="flex gap-2 overflow-x-auto">
      {names.map((name) => {
        const href = `/api/files/${encodeURIComponent(customer)}/${encodeURIComponent(name)}`
        return (
          <a key={name} href={href} target="_blank" rel="noreferrer" className="shrink-0" title={name}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={href} alt={name} className={`${height} w-auto max-w-40 rounded border object-cover`} />
          </a>
        )
      })}
    </div>
  )
}
