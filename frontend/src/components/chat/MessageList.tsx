import * as React from "react";
import { ArrowDown, BookOpen, Bug, Code2, FileText, Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { ChatMessage, TypingIndicator, type Message } from "@/components/chat/ChatMessage";
import { useChatContext } from "@/context/ChatContext";

interface MessageListProps {
  messages: Message[];
  isGenerating?: boolean;
  className?: string;
}

export function MessageList({ messages, isGenerating = false, className }: MessageListProps) {
  const { conversationId, regenerateMessage, editMessage, rateMessage, switchVariant } = useChatContext();
  // Stable references passed to every ChatMessage - see the O(n²) memoization contract
  // in agents.md. All are useCallbacks in ChatContext, so these wrappers' identities
  // only change when those do, not on every render/token.
  const handleRegenerate = React.useCallback(
    (messageId: string) => regenerateMessage(messageId),
    [regenerateMessage],
  );
  const handleEdit = React.useCallback(
    (messageId: string, newText: string) => editMessage(messageId, newText),
    [editMessage],
  );
  const handleRate = React.useCallback(
    (messageId: string, rating: 'up' | 'down' | null) => { void rateMessage(messageId, rating) },
    [rateMessage],
  );
  const handleSwitchVariant = React.useCallback(
    (variantId: string) => { void switchVariant(variantId) },
    [switchVariant],
  );
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const msgsContainerRef = React.useRef<HTMLDivElement>(null);
  const spacerRef = React.useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = React.useState(false);
  const atBottomRef = React.useRef(true);

  // Size the spacer to exactly fill the gap below the most recent turn, so the user
  // prompt can be pinned to the top of the viewport while the response types out
  // underneath. As the response grows the spacer shrinks; once the turn is taller
  // than the viewport the spacer is 0 and following the bottom behaves normally.
  // Returns false when there's nothing to size (no active turn).
  const sizeSpacer = React.useCallback(() => {
    const container = containerRef.current;
    const msgsEl = msgsContainerRef.current;
    const spacer = spacerRef.current;
    if (!container || !msgsEl || !spacer) return false;
    const children = msgsEl.children;
    // Second-to-last child is the latest user message; last is the assistant reply.
    const userEl = children[children.length - 2] as HTMLElement | undefined;
    if (!userEl) return false;
    const turnTop = userEl.getBoundingClientRect().top - msgsEl.getBoundingClientRect().top;
    const turnHeight = msgsEl.offsetHeight - turnTop;
    spacer.style.height = `${Math.max(0, container.clientHeight - turnHeight)}px`;
    return true;
  }, []);

  // When a conversation is loaded (not generating), clear any spacer and jump to bottom.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!isGenerating && messages.length > 0) {
      if (spacerRef.current) spacerRef.current.style.height = "";
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [messages.length, conversationId]);

  // Generation start: size the spacer and scroll so the user prompt sits at the top.
  React.useEffect(() => {
    if (!isGenerating) return;
    atBottomRef.current = true;
    if (sizeSpacer()) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGenerating]);

  // Auto-follow: as tokens stream in, keep the spacer sized and the bottom in view,
  // but only if the user hasn't scrolled up to read earlier content. With a correctly
  // sized spacer the bottom is the bottom of the content, never empty space.
  React.useEffect(() => {
    if (!isGenerating) return;
    sizeSpacer();
    const last = messages[messages.length - 1];
    if (!last?.content) return; // skip empty assistant placeholder on initial add
    if (!atBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distFromBottom < 80;
    setShowScrollBtn(distFromBottom > 100);
  }

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <div className={cn("relative flex-1 overflow-hidden", className)}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="chat-scroll h-full overflow-y-auto"
      >
        {/* Trailing padding keeps the last message clear of the static composer. */}
        <div className={cn("pb-6", messages.length === 0 && "min-h-full")}>
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            <div ref={msgsContainerRef} className="flex flex-col gap-3">
              {messages.map((msg, i) => (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  isLast={i === messages.length - 1}
                  isGenerating={isGenerating}
                  onRegenerate={handleRegenerate}
                  onEdit={handleEdit}
                  onRate={handleRate}
                  onSwitchVariant={handleSwitchVariant}
                />
              ))}
              {isGenerating && messages.at(-1)?.role === "user" && <TypingIndicator />}
            </div>
          )}
          <div ref={spacerRef} aria-hidden />
          <div ref={bottomRef} />
        </div>
      </div>

      {showScrollBtn && (
        <Button
          variant="outline"
          size="sm"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 gap-1.5 shadow-md"
        >
          <ArrowDown className="size-3" />
          Scroll to bottom
        </Button>
      )}
    </div>
  );
}

const STARTERS = [
  {
    label: "Explain a concept",
    prompt: "Explain a concept",
    Icon: BookOpen,
    bg: "bg-brand/15",
    fg: "text-brand",
  },
  {
    label: "Write a script",
    prompt: "Write a script",
    Icon: Code2,
    bg: "bg-warning/15",
    fg: "text-warning",
  },
  {
    label: "Help me debug",
    prompt: "Help me debug",
    Icon: Bug,
    bg: "bg-destructive/15",
    fg: "text-destructive",
  },
  {
    label: "Summarize text",
    prompt: "Summarize something",
    Icon: FileText,
    bg: "bg-success/15",
    fg: "text-success",
  },
]

function EmptyState() {
  const { submit } = useChatContext()

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-10 py-16">
      <h2 className="text-4xl font-bold tracking-tight text-center">How can I help?</h2>
      <p className="mt-3 text-base text-muted-foreground text-center max-w-md">
        Start a conversation or pick something below to jump right in.
      </p>

      <div className="mt-10 grid grid-cols-2 gap-4 w-full max-w-2xl">
        {STARTERS.map(({ label, prompt, Icon, bg, fg }) => (
          <Button
            key={label}
            variant="ghost"
            onClick={() => submit(undefined, prompt)}
            className="group h-auto justify-start gap-4 whitespace-normal rounded-card border border-border/40 bg-card px-5 py-4 text-left transition-all hover:border-border hover:bg-card/80 hover:shadow-sm"
          >
            <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-control", bg)}>
              <Icon className={cn("size-5", fg)} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-foreground">{label}</span>
            </span>
            <Plus className="size-4 shrink-0 text-muted-foreground/30 transition-colors group-hover:text-muted-foreground" />
          </Button>
        ))}
      </div>

      <div className="mt-8 flex items-start gap-3 rounded-card bg-muted/40 border border-border/20 px-5 py-3.5 text-left w-full max-w-2xl">
        <Sparkles className="size-3.5 text-primary/60 mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          <span className="font-medium text-foreground/70">Tip:</span> Your companion is available
          anywhere in Loki Doki via the bar at the bottom. Use Chat to save conversations or organize work into projects.
        </p>
      </div>
    </div>
  )
}
