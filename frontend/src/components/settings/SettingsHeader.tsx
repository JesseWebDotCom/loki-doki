import { Menu } from 'lucide-react'
import {
  Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'

interface Props {
  sectionLabel: string
  onOpenMobileNav: () => void
  onNavigate: (sectionId: string) => void
}

// Sticky content-pane header — same anatomy as Admin's AdminHeader (breadcrumb + mobile
// nav trigger), scaled down: Settings has no cross-section search/command palette.
export function SettingsHeader({ sectionLabel, onOpenMobileNav, onNavigate }: Props) {
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

        <Breadcrumb>
          <BreadcrumbList className="flex-nowrap">
            <BreadcrumbItem>
              <BreadcrumbLink onClick={() => onNavigate('profile')} className="cursor-pointer">
                Settings
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{sectionLabel}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </header>
  )
}
