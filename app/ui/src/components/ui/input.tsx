import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "tap-target flex min-h-11 w-full rounded-2xl border border-[var(--line)] bg-[var(--input)] px-4 py-2 text-sm text-[var(--foreground)] shadow-[var(--shadow-soft)] outline-none transition focus:border-[var(--ring)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]/30 motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  )
)
Input.displayName = "Input"

export { Input }
