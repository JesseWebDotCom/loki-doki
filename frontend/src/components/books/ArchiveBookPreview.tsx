export function ArchiveBookPreview({ identifier, title }: { identifier: string; title: string }) {
  const src = `https://archive.org/embed/${encodeURIComponent(identifier)}`
  return (
    <section>
      <h2 className="mb-3 text-lg font-bold">Preview</h2>
      <div className="h-[min(72vh,760px)] overflow-hidden rounded-card border border-border bg-card">
        <iframe src={src} title={`Preview ${title}`} className="size-full border-0" allow="fullscreen" />
      </div>
    </section>
  )
}
