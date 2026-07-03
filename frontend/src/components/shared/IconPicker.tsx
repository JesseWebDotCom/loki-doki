import { useMemo, useState } from 'react'
import {
  AnchorIcon, AtomIcon, BeakerIcon, BellIcon, BookIcon, BookmarkIcon,
  BotIcon, BoxIcon, BrainIcon, BriefcaseIcon, CalendarIcon, CameraIcon,
  CarIcon, ChefHatIcon, ChevronDown, CodeIcon, CompassIcon, CpuIcon,
  CrownIcon, DatabaseIcon, DumbbellIcon, FeatherIcon, FilmIcon, FlameIcon,
  FlaskConicalIcon, FolderIcon, GamepadIcon, GhostIcon, GiftIcon, GlobeIcon,
  GraduationCapIcon, HammerIcon, HeadphonesIcon, HeartIcon, HouseIcon,
  KeyboardIcon, LeafIcon, LibraryIcon, LightbulbIcon, MapIcon, MicIcon,
  MountainIcon, MusicIcon, NotebookIcon, PaletteIcon, PlaneIcon, RocketIcon,
  SparklesIcon, StarIcon, TargetIcon, TerminalIcon, WrenchIcon, ZapIcon,
  type LucideIcon,
} from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'

export interface IconChoice {
  slug: string
  label: string
  Icon: LucideIcon
}

export const ICON_CHOICES: IconChoice[] = [
  { slug: 'rocket',          label: 'Rocket',          Icon: RocketIcon },
  { slug: 'sparkles',        label: 'Sparkles',        Icon: SparklesIcon },
  { slug: 'star',            label: 'Star',            Icon: StarIcon },
  { slug: 'heart',           label: 'Heart',           Icon: HeartIcon },
  { slug: 'flame',           label: 'Flame',           Icon: FlameIcon },
  { slug: 'zap',             label: 'Zap',             Icon: ZapIcon },
  { slug: 'lightbulb',       label: 'Lightbulb',       Icon: LightbulbIcon },
  { slug: 'brain',           label: 'Brain',           Icon: BrainIcon },
  { slug: 'bot',             label: 'Bot',             Icon: BotIcon },
  { slug: 'ghost',           label: 'Ghost',           Icon: GhostIcon },
  { slug: 'crown',           label: 'Crown',           Icon: CrownIcon },
  { slug: 'feather',         label: 'Feather',         Icon: FeatherIcon },
  { slug: 'leaf',            label: 'Leaf',            Icon: LeafIcon },
  { slug: 'mountain',        label: 'Mountain',        Icon: MountainIcon },
  { slug: 'globe',           label: 'Globe',           Icon: GlobeIcon },
  { slug: 'anchor',          label: 'Anchor',          Icon: AnchorIcon },
  { slug: 'compass',         label: 'Compass',         Icon: CompassIcon },
  { slug: 'map',             label: 'Map',             Icon: MapIcon },
  { slug: 'house',           label: 'House',           Icon: HouseIcon },
  { slug: 'folder',          label: 'Folder',          Icon: FolderIcon },
  { slug: 'box',             label: 'Box',             Icon: BoxIcon },
  { slug: 'library',         label: 'Library',         Icon: LibraryIcon },
  { slug: 'book',            label: 'Book',            Icon: BookIcon },
  { slug: 'notebook',        label: 'Notebook',        Icon: NotebookIcon },
  { slug: 'bookmark',        label: 'Bookmark',        Icon: BookmarkIcon },
  { slug: 'calendar',        label: 'Calendar',        Icon: CalendarIcon },
  { slug: 'bell',            label: 'Bell',            Icon: BellIcon },
  { slug: 'briefcase',       label: 'Briefcase',       Icon: BriefcaseIcon },
  { slug: 'graduation-cap',  label: 'Graduation cap',  Icon: GraduationCapIcon },
  { slug: 'code',            label: 'Code',            Icon: CodeIcon },
  { slug: 'terminal',        label: 'Terminal',        Icon: TerminalIcon },
  { slug: 'keyboard',        label: 'Keyboard',        Icon: KeyboardIcon },
  { slug: 'cpu',             label: 'CPU',             Icon: CpuIcon },
  { slug: 'database',        label: 'Database',        Icon: DatabaseIcon },
  { slug: 'atom',            label: 'Atom',            Icon: AtomIcon },
  { slug: 'beaker',          label: 'Beaker',          Icon: BeakerIcon },
  { slug: 'flask-conical',   label: 'Flask',           Icon: FlaskConicalIcon },
  { slug: 'wrench',          label: 'Wrench',          Icon: WrenchIcon },
  { slug: 'hammer',          label: 'Hammer',          Icon: HammerIcon },
  { slug: 'palette',         label: 'Palette',         Icon: PaletteIcon },
  { slug: 'music',           label: 'Music',           Icon: MusicIcon },
  { slug: 'headphones',      label: 'Headphones',      Icon: HeadphonesIcon },
  { slug: 'mic',             label: 'Mic',             Icon: MicIcon },
  { slug: 'camera',          label: 'Camera',          Icon: CameraIcon },
  { slug: 'film',            label: 'Film',            Icon: FilmIcon },
  { slug: 'gamepad',         label: 'Gamepad',         Icon: GamepadIcon },
  { slug: 'gift',            label: 'Gift',            Icon: GiftIcon },
  { slug: 'chef-hat',        label: 'Chef hat',        Icon: ChefHatIcon },
  { slug: 'dumbbell',        label: 'Dumbbell',        Icon: DumbbellIcon },
  { slug: 'plane',           label: 'Plane',           Icon: PlaneIcon },
  { slug: 'car',             label: 'Car',             Icon: CarIcon },
  { slug: 'target',          label: 'Target',          Icon: TargetIcon },
]

const ICON_BY_SLUG: Record<string, IconChoice> = Object.fromEntries(
  ICON_CHOICES.map((c) => [c.slug, c]),
)

export function getIconChoice(slug: string | null | undefined): IconChoice | null {
  if (!slug) return null
  return ICON_BY_SLUG[slug] ?? null
}

interface IconPickerProps {
  value: string | null
  onChange: (slug: string | null) => void
}

export function IconPicker({ value, onChange }: IconPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = getIconChoice(value)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return ICON_CHOICES
    return ICON_CHOICES.filter(
      (c) => c.slug.includes(needle) || c.label.toLowerCase().includes(needle),
    )
  }, [query])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'outline' }), 'w-full justify-between')}
          aria-label="Project icon"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <>
                <selected.Icon className="size-4 shrink-0" />
                <span className="truncate">{selected.label}</span>
              </>
            ) : (
              <span className="truncate text-muted-foreground">Pick icon</span>
            )}
          </span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80 p-2" align="start">
        <div className="grid gap-2">
          <Input
            type="search"
            placeholder="Search icons"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search icons"
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div
            role="radiogroup"
            aria-label="Project icon"
            className="grid max-h-48 grid-cols-8 gap-1 overflow-y-auto rounded-control border border-border bg-muted p-2"
          >
            {filtered.map((choice) => {
              const isSelected = choice.slug === value
              return (
                <button
                  key={choice.slug}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={`Select ${choice.label} icon`}
                  title={choice.label}
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-control text-muted-foreground transition hover:bg-accent hover:text-accent-foreground',
                    isSelected ? 'bg-accent text-accent-foreground ring-2 ring-primary' : '',
                  )}
                  onClick={() => { onChange(isSelected ? null : choice.slug); setOpen(false) }}
                >
                  <choice.Icon className="size-4" />
                </button>
              )
            })}
            {filtered.length === 0 && (
              <p className="col-span-8 px-2 py-3 text-center text-xs text-muted-foreground">
                No icons match &ldquo;{query}&rdquo;.
              </p>
            )}
          </div>
          {value !== null && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-self-start px-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => { onChange(null); setOpen(false) }}
            >
              Clear icon
            </Button>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
