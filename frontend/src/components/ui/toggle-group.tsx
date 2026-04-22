import * as React from "react"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

/**
 * shadcn-style ToggleGroup built on top of ``@radix-ui/react-toggle-group``.
 *
 * The ``radix-ui`` meta package already bundles ``react-toggle-group`` — no
 * new npm dep. Follows the Onyx Material "elevated pill" visual language
 * used by the compose-bar controls: subtle border, soft shadow, primary
 * tint when pressed. Items default to a 44px touch target (Onyx spec).
 */
const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn(
      "inline-flex items-center gap-1 rounded-full border border-border/50 bg-card/60 p-1 shadow-m1",
      className,
    )}
    {...props}
  />
))
ToggleGroup.displayName = "ToggleGroup"

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <ToggleGroupPrimitive.Item
    ref={ref}
    className={cn(
      "inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full px-4 text-xs font-medium text-muted-foreground transition-colors",
      "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
      "data-[state=on]:bg-primary/15 data-[state=on]:text-primary data-[state=on]:shadow-m1",
      "disabled:pointer-events-none disabled:opacity-50",
      className,
    )}
    {...props}
  >
    {children}
  </ToggleGroupPrimitive.Item>
))
ToggleGroupItem.displayName = "ToggleGroupItem"

export { ToggleGroup, ToggleGroupItem }
