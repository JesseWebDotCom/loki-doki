import * as React from "react"

import { cn } from "@/lib/utils"

const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-lg border border-[var(--line)] bg-[var(--input)] px-3 py-1 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]",
        className
      )}
      {...props}
    />
  )
)

Select.displayName = "Select"

export { Select }
