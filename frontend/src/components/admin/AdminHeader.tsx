import { Menu, Search } from 'lucide-react'
import {
  Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink,
  BreadcrumbPage, BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'

interface Props {
  sectionId: string
  sectionLabel: string
  subLabel?: string
  description?: string
  onOpenMobileNav: () => void
  onOpenPalette: () => void
  onNavigate: (sectionId: string, subId?: string) => void
}

// Sticky content-pane header: breadcrumb + section description, a mobile nav trigger,
// and a ⌘K search affordance. Renders on every admin section so users always know
// where they are after a palette jump or deep-link.
export function AdminHeader({
  sectionId, sectionLabel, subLabel, description, onOpenMobileNav, onOpenPalette, onNavigate,
}: Props) {
  return (
    <header className="sticky top-0 z-20 border-b border-border/40 bg-background/80 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:px-5">
      <div className="flex items-center gap-3">
        <button
          onClick={onOpenMobileNav}
          className="-ml-1 rounded-lg p-1.5 text-muted-foreground hover:bg-foreground/6 hover:text-foreground md:hidden"
          aria-label="Open navigation"
        >
          <Menu className="size-5" />
        </button>

        <div className="min-w-0 flex-1">
          <Breadcrumb>
            <BreadcrumbList className="flex-nowrap">
              <BreadcrumbItem>
                <BreadcrumbLink onClick={() => onNavigate('overview')} className="cursor-pointer">
                  Admin
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {subLabel ? (
                  <BreadcrumbLink onClick={() => onNavigate(sectionId)} className="cursor-pointer">
                    {sectionLabel}
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{sectionLabel}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {subLabel && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage className="truncate">{subLabel}</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          {description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
          )}
        </div>

        <button
          onClick={onOpenPalette}
          className="flex shrink-0 items-center gap-2 rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/6"
        >
          <Search className="size-3.5" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden rounded border border-border/60 bg-muted px-1 font-sans text-[10px] sm:inline">⌘K</kbd>
        </button>
      </div>
    </header>
  )
}
