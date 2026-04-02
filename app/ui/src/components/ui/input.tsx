import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-11 w-full rounded-2xl border border-[var(--line)] bg-[var(--input)] px-4 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]",
        className
      )}
      {...props}
    />
  )
)
Input.displayName = "Input"

export { Input }
