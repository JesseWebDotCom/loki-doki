import { cn } from '@/lib/cn'

/**
 * The MaiPai Home app logo. Renders the canonical brand mark from `/favicon.svg`
 * so the tab icon, sidebar, setup wizard, and boot screen all stay in sync —
 * update the SVG once and every surface follows. Size via `className`
 * (e.g. `size-10`); the SVG carries its own rounded tile + gradient.
 *
 * Set `glow` for hero placements (boot/setup) to add a soft violet bloom that
 * hugs the squircle — a layered `drop-shadow` keyed off the SVG's alpha.
 */
export function BrandMark({ className, glow = false }: { className?: string; glow?: boolean }) {
  return (
    <img
      src="/favicon.svg"
      alt="MaiPai Home"
      draggable={false}
      className={cn(
        'shrink-0 select-none',
        glow &&
          '[filter:drop-shadow(0_0_16px_rgba(124,58,237,0.55))_drop-shadow(0_8px_48px_rgba(139,92,246,0.45))]',
        className,
      )}
    />
  )
}
