export function GoogleBooksPreview({ volumeId, title }: { volumeId: string; title: string }) {
  const src = `https://books.google.com/books?id=${encodeURIComponent(volumeId)}&printsec=frontcover&output=embed`
  return (
    <section>
      <h2 className="mb-3 text-lg font-bold">Read a sample</h2>
      <div className="h-[min(72vh,760px)] overflow-hidden rounded-card border border-border bg-card">
        <iframe src={src} title={`Preview ${title}`} className="size-full border-0" allow="fullscreen" />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">The publisher controls which pages are included in this sample.</p>
    </section>
  )
}
