import * as React from "react"

import { cn } from "@/lib/utils"

type TabsListProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: "pill" | "line"
}

export function TabsList({
  className,
  variant = "pill",
  ...props
}: TabsListProps) {
  return (
    <div
      className={cn(
        variant === "line"
          ? "inline-flex items-center gap-1 border-b border-[var(--line)]"
          : "inline-flex rounded-full border border-[var(--line)] bg-[var(--card)] p-1",
        className
      )}
      {...props}
    />
  )
}

type TabsTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean
  variant?: "pill" | "line"
}

export function TabsTrigger({
  active = false,
  className,
  variant = "pill",
  ...props
}: TabsTriggerProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        variant === "line"
          ? active
            ? "border-b-2 border-[var(--accent)] px-3 py-2 text-[var(--foreground)]"
            : "border-b-2 border-transparent px-3 py-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          : active
            ? "rounded-full bg-[var(--accent)] px-4 py-2 text-[var(--accent-foreground)]"
            : "rounded-full px-4 py-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
        className
      )}
      type="button"
      {...props}
    />
  )
}
