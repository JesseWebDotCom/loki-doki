import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

interface ScrollFadeProps {
  children: ReactNode;
  /** Extra classes for the inner scroll container (spacing, etc.). */
  className?: string;
  /** Height utility for the fade masks. Defaults to `h-5`. */
  fadeSize?: string;
}

/**
 * Wraps a vertically-scrollable region that hides its scrollbar and shows soft
 * top/bottom fade masks whenever there's more content to scroll to; a
 * lightweight "there's more above / below" affordance. The masks fade in only
 * when the corresponding edge is scrolled away from, so a list that fits shows
 * nothing.
 */
export function ScrollFade({ children, className, fadeSize = "h-5" }: ScrollFadeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    setAtTop(scrollTop <= 1);
    setAtBottom(scrollTop + clientHeight >= scrollHeight - 1);
  }, []);

  useEffect(() => {
    update();
    // Re-evaluate on container resize AND content growth (items pinned/removed).
    const ro = new ResizeObserver(update);
    if (scrollRef.current) ro.observe(scrollRef.current);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, [update]);

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={update}
        className={cn("h-full overflow-y-auto no-scrollbar", className)}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-background to-transparent transition-opacity duration-200",
          fadeSize,
          atTop ? "opacity-0" : "opacity-100",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background to-transparent transition-opacity duration-200",
          fadeSize,
          atBottom ? "opacity-0" : "opacity-100",
        )}
      />
    </div>
  );
}
