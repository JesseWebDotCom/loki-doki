import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-full text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border border-transparent bg-[var(--accent)] text-[var(--accent-foreground)] shadow-[var(--shadow-soft)] hover:bg-[var(--accent-strong)] hover:shadow-[var(--shadow-strong)]",
        outline: "border border-[var(--line)] bg-[var(--card)] text-[var(--foreground)] shadow-[var(--shadow-soft)] hover:bg-[var(--input)] hover:border-[var(--ring)]/45",
        ghost: "text-[var(--muted-foreground)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]",
      },
      size: {
        default: "h-11 px-5",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  tooltip?: string
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, tooltip, title, ...props }, ref) => (
    <button
      className={cn(
        buttonVariants({ variant, size }),
        "tap-target focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] active:translate-y-px disabled:cursor-not-allowed motion-safe:duration-200 motion-reduce:transition-none",
        className
      )}
      data-icon-only={size === "icon" ? "true" : undefined}
      ref={ref}
      title={title ?? tooltip}
      {...props}
    />
  )
)
Button.displayName = "Button"

export { Button, buttonVariants }
