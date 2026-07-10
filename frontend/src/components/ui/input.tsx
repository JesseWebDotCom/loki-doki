import * as React from "react";
import { cn } from "@/lib/cn";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  function Input({ className, type, ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(
          // text-base on mobile: iOS Safari zooms the page on focus when an input's
          // computed font-size is under 16px (Mobile Design Contract). Never override
          // back down with text-sm/text-xs on phone widths.
          "h-8 w-full min-w-0 rounded-control border border-input bg-transparent px-2.5 py-1 text-base md:text-sm outline-none",
          "placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);

export { Input };
