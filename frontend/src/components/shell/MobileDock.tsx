import { useCallback, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Bot, Home, Menu, Mic } from "lucide-react";
import { cn } from "@/lib/cn";
import { CharacterAvatar } from "@/components/companion/CharacterAvatar";
import { CompanionComposer } from "./CompanionComposer";
import { useCompanionEngine } from "./CompanionEngineContext";
import { ChromeWash } from "@/components/shared/ChromeWash";
import { MobileNavSheet } from "./MobileNavSheet";
import { stripEmotes } from "@/lib/emoteParser";

// The mobile bottom dock: Home, the companion prompt pill (the ONE companion head on
// mobile, talking to it expands a composer sheet, not a second avatar), and a Menu button
// that opens the app launcher / account drawer. Replaces the old five-tab bar (Home / Chat /
// Library / Weather + a center puck) whose expand sheet rendered a duplicate companion head.
export function MobileDock() {
  const { pathname } = useLocation();
  // The shared engine gives the pill the same brain (routing, stop interception, voice
  // priming) as the desktop sidebar dock.
  const engine = useCompanionEngine();
  const { character, avatarProps, thinking, replyText, handsFreeOn, setHandsFree } = engine;
  const [composerOpen, setComposerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const isOnChat = pathname.startsWith("/chat");
  const homeActive = pathname === "/";

  // Strip <action>…</action> emote tags from the visible caption (they drive the mood
  // overlay, not the text); also drop a dangling partial tag mid-stream so it doesn't flash
  // before the closing tag arrives.
  const captionText = useMemo(
    () => stripEmotes(replyText).replace(/<\/?(?:a(?:c(?:t(?:i(?:o(?:n(?:>[^<]*)?)?)?)?)?)?)?$/i, "").trimEnd(),
    [replyText],
  );

  const handleSend = useCallback(
    (text: string, files?: File[]) => {
      engine.handleSend(text, files);
      // On chat the reply lands in the message stream; close the sheet so it's visible.
      // Off chat the ephemeral reply renders inside the sheet, so keep it open.
      if (isOnChat) setComposerOpen(false);
    },
    [engine, isOnChat],
  );

  return (
    <>
      {/* Expanding composer sheet above the dock, no avatar here (the pill owns it). */}
      {composerOpen && (
        <>
          {/* design-ok(raw-overlay): mobile companion sheet dismiss-scrim; deliberately not
              ui/dialog (no focus-trap/ESC, would fight hands-free voice UX), same rationale
              as PlexPlayer/PrivacyOverlay */}
          <div className="md:hidden fixed inset-0 z-[9998]" onClick={() => setComposerOpen(false)} />
          <div className="md:hidden fixed inset-x-3 bottom-[76px] z-[9999] rounded-sheet border border-border/40 bg-background/95 p-2 shadow-2xl backdrop-blur-xl pb-safe">
            {/* Ephemeral reply caption (off the chat app, not saved) */}
            {!isOnChat && (captionText || thinking) && (
              <p className="mb-2 max-h-24 overflow-y-auto rounded-card bg-muted/60 px-3 py-1.5 text-sm">
                {captionText || "…"}
              </p>
            )}
            <CompanionComposer
              onSend={handleSend}
              onStop={engine.onStop}
              isGenerating={engine.busy}
              isThinking={thinking}
              autoFocus
              placeholder={character ? `Ask ${character.name}…` : "Message Loki Doki…"}
            />
            {!isOnChat && (
              <p className="mt-1 px-1 text-[10px] text-muted-foreground/50">chatting here won’t be saved</p>
            )}
          </div>
        </>
      )}

      <nav className="md:hidden relative shrink-0 flex items-center gap-2 glass-chrome border-t border-border/50 px-3 py-2 pb-safe">
        <ChromeWash />

        {/* Home */}
        <Link
          to="/"
          aria-label="Home"
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full transition-colors",
            homeActive ? "text-brand" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Home className={cn("size-6", homeActive && "stroke-[2.5]")} />
        </Link>

        {/* Companion prompt pill: tap to chat, mic to talk hands-free */}
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-full border border-border/60 bg-card/80 py-1 pl-1 pr-1 shadow-sm">
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-full py-1 pl-1 pr-2 text-left"
          >
            <span className="flex size-8 shrink-0 items-center justify-center">
              {character ? (
                <CharacterAvatar
                  character={character}
                  streaming={avatarProps.streaming}
                  thinking={thinking}
                  size={32}
                  viewPreset="head"
                />
              ) : (
                <span className="grid size-8 place-items-center rounded-full bg-muted">
                  <Bot className="size-4 text-muted-foreground" />
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {captionText && !isOnChat
                ? captionText
                : character
                  ? `Ask ${character.name}…`
                  : "Ask anything…"}
            </span>
          </button>
          <button
            type="button"
            aria-label={handsFreeOn ? "Turn off voice" : "Talk"}
            aria-pressed={handsFreeOn}
            onClick={() => setHandsFree(!handsFreeOn)}
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-full transition-colors",
              handsFreeOn ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Mic className="size-4" />
          </button>
        </div>

        {/* Menu */}
        <button
          type="button"
          aria-label="Menu"
          onClick={() => setMenuOpen(true)}
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
        >
          <Menu className="size-6" />
        </button>
      </nav>

      <MobileNavSheet open={menuOpen} onOpenChange={setMenuOpen} />
    </>
  );
}
