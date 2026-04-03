import * as React from "react"

import { cn } from "@/lib/utils"

const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "tap-target flex min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--input)] px-3 py-2 text-sm text-[var(--foreground)] shadow-[var(--shadow-soft)] outline-none transition focus:border-[var(--ring)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]/30 motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  )
)

Select.displayName = "Select"

export { Select }
