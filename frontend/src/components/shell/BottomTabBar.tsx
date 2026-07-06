import { useCallback, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Bot,
  Cloud,
  LayoutGrid,
  Home,
  MessageCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { CharacterAvatar } from "@/components/companion/CharacterAvatar";
import { CompanionComposer } from "./CompanionComposer";
import { useCompanionEngine } from "./CompanionEngineContext";
import { ChromeWash } from "@/components/shared/ChromeWash";
import { stripEmotes } from "@/lib/emoteParser";

interface TabItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

// Two tabs each side of the centered companion.
const LEFT_TABS: TabItem[] = [
  { label: "Home", href: "/", icon: Home },
  { label: "Chat", href: "/chat", icon: MessageCircle },
];
const RIGHT_TABS: TabItem[] = [
  { label: "Library", href: "/categories", icon: LayoutGrid },
  { label: "Weather", href: "/weather", icon: Cloud },
];

function Tab({ item }: { item: TabItem }) {
  const { pathname } = useLocation();
  const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
  return (
    <Link
      to={item.href}
      className={cn(
        "flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] transition-colors",
        active ? "text-brand font-medium" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <item.icon className={cn("size-5", active && "stroke-[2.5]")} />
      {item.label}
    </Link>
  );
}

export function BottomTabBar() {
  const { pathname } = useLocation();
  // Mobile keeps the tab-bar puck as its companion home; the shared engine
  // provides the same brain (routing, stop interception, voice priming) as the
  // desktop sidebar dock.
  const engine = useCompanionEngine();
  const { character, avatarProps, thinking, replyText } = engine;
  const [open, setOpen] = useState(false);

  const isOnChat = pathname.startsWith("/chat");
  // Strip <action>...</action> emote tags from the visible caption (they drive the
  // mood overlay, not the text); also drop a dangling partial tag mid-stream so it
  // doesn't flash before the closing tag arrives.
  const captionText = useMemo(
    () => stripEmotes(replyText).replace(/<\/?(?:a(?:c(?:t(?:i(?:o(?:n(?:>[^<]*)?)?)?)?)?)?)?$/i, "").trimEnd(),
    [replyText],
  );

  const handleSend = useCallback((text: string, files?: File[]) => {
    engine.handleSend(text, files);
    // On chat the reply lands in the message stream; close the sheet so it's visible.
    // Off chat the ephemeral reply renders inside the sheet, so keep it open.
    if (isOnChat) setOpen(false);
  }, [engine, isOnChat]);

  return (
    <>
      {/* Expanding companion sheet above the bar */}
      {open && (
        <>
          {/* design-ok(raw-overlay): mobile companion sheet dismiss-scrim; deliberately not ui/dialog
              (no focus-trap/ESC — would fight hands-free voice UX), same rationale as PlexPlayer/PrivacyOverlay */}
          <div className="md:hidden fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div className="md:hidden fixed inset-x-3 bottom-[68px] z-[9999] rounded-sheet border border-border/40 bg-background/95 p-2 shadow-2xl backdrop-blur-xl pb-safe">
            {/* Ephemeral reply caption (off the chat app, not saved) */}
            {!isOnChat && (captionText || thinking) && (
              <p className="mb-2 max-h-24 overflow-y-auto rounded-card bg-muted/60 px-3 py-1.5 text-sm">
                {captionText || "…"}
              </p>
            )}
            <div className="flex items-center gap-2">
              <div className="size-14 shrink-0">
                {character ? (
                  <CharacterAvatar character={character} streaming={avatarProps.streaming} thinking={thinking} size={56} viewPreset="head" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center rounded-full border border-border bg-muted">
                    <Bot className="size-6 text-muted-foreground" />
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <CompanionComposer
                  onSend={handleSend}
                  onStop={engine.onStop}
                  isGenerating={engine.busy}
                  isThinking={thinking}
                  autoFocus
                  placeholder={character ? `Ask ${character.name}…` : "Message LokiDoki…"}
                />
                {!isOnChat && <p className="mt-1 px-1 text-[10px] text-muted-foreground/50">chatting here won’t be saved</p>}
              </div>
            </div>
          </div>
        </>
      )}

      <nav className="md:hidden relative shrink-0 flex items-center glass-chrome border-t border-border/50 pb-safe">
        <ChromeWash />
        {LEFT_TABS.map((item) => <Tab key={item.href} item={item} />)}

        {/* Center companion */}
        <button
          type="button"
          aria-label="Companion"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 flex-col items-center -mt-4"
        >
          <span className={cn(
            "flex size-12 items-center justify-center transition-transform",
            !character && "overflow-hidden rounded-full border-2 border-background bg-card shadow-lg",
            open && "scale-110",
          )}>
            {character ? (
              <CharacterAvatar character={character} streaming={avatarProps.streaming} thinking={thinking} size={48} viewPreset="head" />
            ) : (
              <Bot className="size-6 text-muted-foreground" />
            )}
          </span>
        </button>

        {RIGHT_TABS.map((item) => <Tab key={item.href} item={item} />)}
      </nav>
    </>
  );
}
