import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[120px] w-full rounded-[24px] border border-[var(--line)] bg-[var(--input)] px-4 py-3 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]",
      className
    )}
    {...props}
  />
))
Textarea.displayName = "Textarea"

export { Textarea }
