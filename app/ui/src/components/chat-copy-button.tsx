import { Check, Copy } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function ChatCopyButton({ content, className }: { content: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Button
      aria-label="Copy to clipboard"
      className={cn("relative h-8 w-8 rounded-full", className)}
      onClick={handleCopy}
      size="icon"
      tooltip={copied ? "Copied" : "Copy response"}
      type="button"
      variant="ghost"
    >
      <Check className={cn("absolute h-4 w-4 transition-transform", copied ? "scale-100" : "scale-0")} />
      <Copy className={cn("h-4 w-4 transition-transform", copied ? "scale-0" : "scale-100")} />
    </Button>
  )
}
