import { Check, ChevronDown, LoaderCircle, Settings } from "lucide-react"

import { cn } from "@/lib/utils"

type CharacterOption = {
  id: string
  name: string
  logo: string
  teaser?: string
  enabled: boolean
}

type CharacterQuickSwitcherProps = {
  characters: CharacterOption[]
  selectedCharacter: CharacterOption | null
  open: boolean
  busy: boolean
  pendingCharacterName?: string
  onToggle: () => void
  onSelectCharacter: (characterId: string) => void
  onOpenCharacterSettings: () => void
  footerLabel?: string
  footerSubtitle?: string
  hideFooter?: boolean
}

function CharacterBadge({ character }: { character: CharacterOption | null }) {
  if (character?.logo) {
    return <img alt={`${character.name} logo`} className="h-8 w-8 rounded-full object-cover" src={character.logo} />
  }

  const initial = (character?.name || "L").slice(0, 1).toUpperCase()
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--panel)] text-xs font-semibold text-[var(--foreground)]">
      {initial}
    </div>
  )
}

export function CharacterQuickSwitcher({
  characters,
  selectedCharacter,
  open,
  busy,
  pendingCharacterName,
  onToggle,
  onSelectCharacter,
  onOpenCharacterSettings,
  footerLabel = "More characters",
  footerSubtitle = "Open the settings character area",
  hideFooter = false,
}: CharacterQuickSwitcherProps) {
  return (
    <div className="relative" onPointerDown={(event) => event.stopPropagation()}>
      <button
        aria-expanded={open}
        className="sidebar-hover-surface flex min-h-[52px] items-center gap-3 rounded-[18px] border border-[var(--line)] bg-[var(--input)] px-3 py-2 text-left disabled:cursor-wait disabled:opacity-80"
        disabled={busy}
        onClick={onToggle}
        type="button"
      >
        <CharacterBadge character={selectedCharacter} />
          <div className="min-w-0">
          <div className="truncate text-sm font-medium text-[var(--foreground)]">
            {busy ? pendingCharacterName || selectedCharacter?.name || "LokiDoki" : selectedCharacter?.name || "LokiDoki"}
          </div>
          <div className="max-w-[220px] truncate text-[12px] leading-4 text-[var(--muted-foreground)]">
            {busy ? "Compiling character..." : selectedCharacter?.teaser || "Neutral assistant"}
          </div>
        </div>
        {busy ? (
          <LoaderCircle className="h-4 w-4 animate-spin text-[var(--muted-foreground)]" />
        ) : (
          <ChevronDown className={cn("h-4 w-4 text-[var(--muted-foreground)] transition", open && "rotate-180")} />
        )}
      </button>

      {open ? (
        <div className="quick-switcher-shell absolute left-0 bottom-[calc(100%+10px)] z-50 w-72 rounded-[22px] p-2 shadow-xl">
          <div className="px-3 pb-2 pt-1 text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
            Characters
          </div>
          <div className="space-y-1">
            {characters.map((character) => {
              const isSelected = character.id === selectedCharacter?.id
              return (
                <button
                  key={character.id}
                  className={cn(
                    "quick-switcher-item flex w-full items-center gap-3 rounded-[18px] px-3 py-2.5 text-left disabled:cursor-wait disabled:opacity-60",
                    isSelected
                      ? "is-active text-[var(--foreground)]"
                      : "text-[var(--foreground)]"
                  )}
                  disabled={busy}
                  onClick={() => onSelectCharacter(character.id)}
                  type="button"
                >
                  <CharacterBadge character={character} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{character.name}</div>
                    <div className="line-clamp-2 text-[12px] leading-4 text-[var(--muted-foreground)]">
                      {character.teaser || (character.enabled ? "Ready to use" : "Currently selected")}
                    </div>
                  </div>
                  {isSelected ? <Check className="h-4 w-4 text-[var(--foreground)]" /> : null}
                </button>
              )
            })}
          </div>
          {!hideFooter ? <div className="mt-2 border-t border-[var(--line)] pt-2">
            <button
              className="quick-switcher-item flex w-full items-center gap-3 rounded-[18px] px-3 py-2.5 text-left text-[var(--foreground)] disabled:cursor-wait disabled:opacity-60"
              disabled={busy}
              onClick={onOpenCharacterSettings}
              type="button"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--panel)] text-[var(--muted-foreground)]">
                <Settings className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm font-medium">{footerLabel}</div>
                <div className="text-xs text-[var(--muted-foreground)]">{footerSubtitle}</div>
              </div>
            </button>
          </div> : null}
        </div>
      ) : null}
    </div>
  )
}
