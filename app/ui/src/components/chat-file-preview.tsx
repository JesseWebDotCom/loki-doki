import { FileIcon, FileText, ImageIcon, Video } from "lucide-react"

type ChatFilePreviewProps = {
  kind: "image" | "video" | "document"
  name: string
  previewUrl?: string
  previewText?: string
  meta?: string
  onRemove: () => void
}

export function ChatFilePreview({
  kind,
  name,
  previewUrl,
  previewText,
  meta,
  onRemove,
}: ChatFilePreviewProps) {
  return (
    <div className="chat-file-preview">
      <div className="chat-file-preview-thumb">
        {kind === "image" && previewUrl ? <img alt={name} className="h-full w-full object-cover" src={previewUrl} /> : null}
        {kind === "video" && previewUrl ? <img alt={name} className="h-full w-full object-cover" src={previewUrl} /> : null}
        {kind === "document" ? (
          <div className="chat-file-preview-text">
            {previewText || "Document"}
          </div>
        ) : null}
        {kind === "image" && !previewUrl ? <ImageIcon className="h-5 w-5" /> : null}
        {kind === "video" && !previewUrl ? <Video className="h-5 w-5" /> : null}
        {kind === "document" && !previewText ? <FileText className="h-5 w-5" /> : null}
        {kind !== "image" && kind !== "video" && kind !== "document" ? <FileIcon className="h-5 w-5" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-[var(--foreground)]">{name}</div>
        {meta ? <div className="mt-1 truncate text-xs text-[var(--muted-foreground)]">{meta}</div> : null}
      </div>
      <button className="chat-file-preview-remove" onClick={onRemove} type="button">
        Remove
      </button>
    </div>
  )
}
