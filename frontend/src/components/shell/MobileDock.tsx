import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Bot, Home, Search, Star } from "lucide-react";
import { cn } from "@/lib/cn";
import { AppIconTile } from "@/components/shared/AppIconTile";
import { ArchiveIcon } from "@/components/shared/ArchiveIcon";
import { categoryVisual } from "@/lib/archiveCategories";
import { usePinnedApps } from "@/hooks/usePinnedApps";
import { CharacterAvatar } from "@/components/companion/CharacterAvatar";
import { CompanionComposer, type CompanionComposerHandle } from "./CompanionComposer";
import { useCompanionEngine } from "./CompanionEngineContext";
import { ChromeWash } from "@/components/shared/ChromeWash";
import { MobileYouSheet } from "./MobileYouSheet";
import { MobileCompanionBubble } from "./MobileCompanionBubble";
import { useSpotlight } from "@/components/shared/SpotlightSearch";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { useAuth } from "@/context/AuthContext";
import { useNotifications } from "@/hooks/useNotifications";
import { stripEmotes } from "@/lib/emoteParser";

// The mobile bottom tab bar: Companion (quick-ask sheet) / Home / Search (Spotlight,
// whose empty state doubles as the app launcher) / You (profile + notifications +
// account). Labeled Apple-Music style tabs replace the old unlabeled Home + pill +
// hamburger row. The companion stays a screen-aware ephemeral quick-ask: the sheet is
// the ONLY surface that renders its reply (the old pill mirrored the same text right
// under the sheet, which read as two boxes echoing each other).
export function MobileDock() {
  const { pathname } = useLocation();
  const engine = useCompanionEngine();
  const { character, avatarProps, thinking, replyText, handsFreeOn, setHandsFree } = engine;
  const { user } = useAuth();
  const { openSpotlight, open: spotlightOpen } = useSpotlight();
  // Single notifications instance shared with the You sheet (it polls per-instance;
  // a second instance would let the tab badge and the sheet list drift apart).
  const notif = useNotifications();

  const navigate = useNavigate();
  const favorites = usePinnedApps();

  const [askOpen, setAskOpen] = useState(false);
  const [favOpen, setFavOpen] = useState(false);
  const [youOpen, setYouOpen] = useState(false);

  // Any navigation folds the floating surfaces away (their scrims leave the tab bar
  // tappable, so a tab tap can navigate while one of them is open).
  useEffect(() => {
    setFavOpen(false);
    setAskOpen(false);
  }, [pathname]);
  // Last question asked through the quick-ask sheet; powers "Continue in Chat".
  const [lastAsk, setLastAsk] = useState("");
  const composerRef = useRef<CompanionComposerHandle>(null);

  const isOnChat = pathname.startsWith("/chat");
  const homeActive = pathname === "/";

  // Strip <action>…</action> emote tags from the visible caption (they drive the mood
  // overlay, not the text); also drop a dangling partial tag mid-stream so it doesn't flash
  // before the closing tag arrives.
  const captionText = useMemo(
    () => stripEmotes(replyText).replace(/<\/?(?:a(?:c(?:t(?:i(?:o(?:n(?:>[^<]*)?)?)?)?)?)?)?$/i, "").trimEnd(),
    [replyText],
  );

  // The sheet stays mounted (CSS-hidden) so this can focus the input synchronously
  // inside the tap gesture - iOS only reliably raises the keyboard for in-gesture focus.
  const openAsk = useCallback(() => {
    if (isOnChat) {
      // The chat page has the real composer on screen; focus it instead of layering
      // an ephemeral sheet over a persisted conversation.
      engine.focusComposer();
      return;
    }
    setFavOpen(false);
    setAskOpen(true);
    composerRef.current?.focus();
  }, [isOnChat, engine]);

  // iOS keyboard: position:fixed elements are laid out against the layout viewport,
  // which does NOT shrink when the keyboard opens - without this the sheet ends up
  // underneath the keyboard. Track the visual viewport and ride above it.
  const [kbOffset, setKbOffset] = useState(0);
  useEffect(() => {
    if (!askOpen) {
      setKbOffset(0);
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setKbOffset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [askOpen]);

  const handleSend = useCallback(
    (text: string, files?: File[]) => {
      engine.handleSend(text, files);
      setLastAsk(text);
    },
    [engine],
  );

  const promote = useCallback(() => {
    setAskOpen(false);
    engine.promoteToChat(lastAsk);
  }, [engine, lastAsk]);

  return (
    <>
      {/* Quick-ask sheet: the one companion input on phones. Always mounted (see openAsk). */}
      {askOpen && (
        /* Dismiss-scrim; stops above the bottom chrome so the tab bar stays visible AND
           tappable while the sheet is open. Deliberately not ui/dialog (no focus-trap/ESC,
           would fight hands-free voice UX), same rationale as PlexPlayer/PrivacyOverlay. */
        <div
          className="md:hidden fixed inset-x-0 top-0 bottom-[var(--bottom-chrome,0px)] z-[9998]"
          onClick={() => setAskOpen(false)}
        />
      )}
      <div
        aria-hidden={!askOpen}
        className={cn(
          "md:hidden fixed inset-x-3 bottom-[calc(var(--bottom-chrome,76px)+0.5rem)] z-[9999]",
          "rounded-sheet border border-border/40 bg-background/95 p-2 shadow-2xl backdrop-blur-xl",
          "transition-[opacity,transform] duration-150",
          askOpen ? "opacity-100" : "pointer-events-none translate-y-2 opacity-0",
        )}
        style={kbOffset > 0 ? { transform: `translateY(-${kbOffset}px)` } : undefined}
      >
        {/* Ephemeral reply: rendered here and ONLY here while the sheet is open */}
        {(captionText || thinking) && (
          <p className="mb-2 max-h-32 overflow-y-auto rounded-card bg-muted/60 px-3 py-1.5 text-sm">
            {captionText || "…"}
          </p>
        )}
        <CompanionComposer
          ref={composerRef}
          onSend={handleSend}
          onStop={engine.onStop}
          isGenerating={engine.busy}
          isThinking={thinking}
          placeholder={character ? `Ask ${character.name}…` : "Message Loki Doki…"}
          micOn={handsFreeOn}
          onMicToggle={() => setHandsFree(!handsFreeOn)}
        />
        <div className="mt-1 flex items-center justify-between gap-2 px-1">
          <p className="text-[10px] text-muted-foreground/50">chatting here won&rsquo;t be saved</p>
          {lastAsk && (
            <button type="button" onClick={promote} className="text-[11px] font-medium text-brand">
              Continue in Chat
            </button>
          )}
        </div>
      </div>

      {/* Favorites fan: the user's starred apps/libraries (NavPreferences pins, same list
          as the sidebar Favorites), fanned out above the tab bar for one-tap launch. */}
      {favOpen && (
        <>
          {/* Favorites-fan dismiss-scrim, same shape as the quick-ask scrim above: dimmed
              so the fan reads as a layer, stopping above the still-tappable tab bar. */}
          <div
            className="md:hidden fixed inset-x-0 top-0 bottom-[var(--bottom-chrome,0px)] z-[9998] bg-black/40 animate-in fade-in duration-150"
            onClick={() => setFavOpen(false)}
          />
          <div className="md:hidden fixed inset-x-3 bottom-[calc(var(--bottom-chrome,76px)+0.5rem)] z-[9999] rounded-sheet border border-border/40 bg-background/95 p-3 shadow-2xl backdrop-blur-xl">
            {favorites.length === 0 ? (
              <div className="px-2 py-4 text-center">
                <p className="text-sm text-muted-foreground">No favorites yet.</p>
                <button
                  type="button"
                  onClick={() => {
                    setFavOpen(false);
                    openSpotlight();
                  }}
                  className="mt-1 text-sm font-medium text-brand"
                >
                  Star apps in Search to pin them here
                </button>
              </div>
            ) : (
              <div className="grid max-h-[45vh] grid-cols-4 gap-x-2 gap-y-3 overflow-y-auto overscroll-contain">
                {favorites.map((f, i) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => {
                      setFavOpen(false);
                      navigate(f.href);
                    }}
                    className="flex min-w-0 flex-col items-center gap-1.5 animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards duration-200"
                    style={{ animationDelay: `${Math.min(i, 11) * 30}ms` }}
                  >
                    {f.icon ? (
                      f.gradient ? (
                        <AppIconTile icon={f.icon} gradient={f.gradient} size="lg" />
                      ) : (
                        <AppIconTile icon={f.icon} gradient="" color={f.color ?? "var(--color-brand)"} variant="flat" size="lg" />
                      )
                    ) : (
                      <span
                        className="flex size-14 shrink-0 items-center justify-center rounded-card ring-1 ring-inset ring-white/10 shadow-lg shadow-black/25"
                        style={{ background: categoryVisual(f.archiveCategory ?? "Other").gradient }}
                      >
                        <ArchiveIcon zimIconUrl={f.zimIconUrl ?? null} category={f.archiveCategory ?? "Other"} className="size-7" />
                      </span>
                    )}
                    <span className="max-w-full truncate text-[11px] leading-tight text-muted-foreground">{f.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Proactive replies (briefings, alarms, hands-free answers) while the sheet is
          closed: one transient bubble, tap to open the sheet. Suppressed on /chat where
          the reply already renders in the message stream. */}
      {!askOpen && !isOnChat && (
        <MobileCompanionBubble
          text={captionText}
          thinking={thinking}
          active={thinking || engine.streaming || engine.talkActive}
          onOpen={openAsk}
        />
      )}

      <nav className="md:hidden relative shrink-0 flex items-stretch glass-chrome border-t border-border/50 px-2 pt-1.5 pb-safe">
        <ChromeWash />

        {/* Companion: quick interaction about what's on screen */}
        <button
          type="button"
          aria-label={character ? `Ask ${character.name}` : "Ask companion"}
          aria-expanded={askOpen}
          onClick={() => (askOpen ? setAskOpen(false) : openAsk())}
          className={tabCls(askOpen || (isOnChat && !youOpen))}
        >
          <span className="flex size-7 items-center justify-center">
            {character ? (
              <CharacterAvatar
                character={character}
                streaming={avatarProps.streaming}
                thinking={thinking}
                size={28}
                viewPreset="head"
              />
            ) : (
              <span className="grid size-7 place-items-center rounded-full bg-muted">
                <Bot className="size-4 text-muted-foreground" />
              </span>
            )}
          </span>
          <TabLabel>{character?.name ?? "Companion"}</TabLabel>
        </button>

        {/* Favorites: fans out the starred apps for one-tap launch */}
        <button
          type="button"
          aria-label="Favorites"
          aria-expanded={favOpen}
          onClick={() => setFavOpen((o) => !o)}
          className={tabCls(favOpen)}
        >
          <span className="flex size-7 items-center justify-center">
            <Star className={cn("size-6", favOpen && "fill-current stroke-[2.2]")} />
          </span>
          <TabLabel>Favorites</TabLabel>
        </button>

        {/* Home: center tab */}
        <Link to="/" aria-label="Home" className={tabCls(homeActive)}>
          <span className="flex size-7 items-center justify-center">
            <Home className={cn("size-6", homeActive && "stroke-[2.2]")} />
          </span>
          <TabLabel>Home</TabLabel>
        </Link>

        {/* Search: Spotlight, whose empty state is the app launcher */}
        <button type="button" aria-label="Search and apps" onClick={openSpotlight} className={tabCls(spotlightOpen)}>
          <span className="flex size-7 items-center justify-center">
            <Search className={cn("size-6", spotlightOpen && "stroke-[2.2]")} />
          </span>
          <TabLabel>Search</TabLabel>
        </button>

        {/* You: profile, notifications, settings, sign out */}
        <button type="button" aria-label="You" onClick={() => setYouOpen(true)} className={tabCls(youOpen)}>
          <span className="relative flex size-7 items-center justify-center">
            {user ? (
              <UserAvatar user={user} size={26} />
            ) : (
              <span className="size-6 rounded-full bg-muted" />
            )}
            {notif.unreadCount > 0 && (
              <span className="absolute -right-1 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground">
                {notif.unreadCount > 9 ? "9+" : notif.unreadCount}
              </span>
            )}
          </span>
          <TabLabel>You</TabLabel>
        </button>
      </nav>

      <MobileYouSheet open={youOpen} onOpenChange={setYouOpen} notif={notif} />
    </>
  );
}

function tabCls(active: boolean) {
  return cn(
    "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-control py-1 transition-colors",
    active ? "text-brand" : "text-muted-foreground hover:text-foreground",
  );
}

function TabLabel({ children }: { children: React.ReactNode }) {
  return <span className="max-w-full truncate text-[10px] font-medium leading-none">{children}</span>;
}
