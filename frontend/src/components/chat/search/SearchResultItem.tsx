import type { ChatSearchResult } from "../../../lib/api-types";
import { formatMessageDateTime } from "../../../lib/chatTimestamp";
import { Button } from "../../ui/button";

interface SearchResultItemProps {
  result: ChatSearchResult;
  active?: boolean;
  onSelect: () => void;
}

export default function SearchResultItem({
  result,
  active = false,
  onSelect,
}: SearchResultItemProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onSelect}
      className={`h-auto min-h-11 w-full items-start justify-start rounded-2xl border px-3 py-3 text-left ${
        active
          ? "border-primary/50 bg-primary/10"
          : "border-border/40 bg-card/50 hover:bg-accent/60"
      }`}
      data-slot="search-result-item"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-sm font-semibold text-foreground">
            {result.session_title || "Untitled chat"}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {formatMessageDateTime(result.created_at)}
          </span>
        </div>
        <p
          className="line-clamp-2 text-sm text-muted-foreground"
          dangerouslySetInnerHTML={{ __html: result.snippet }}
        />
      </div>
    </Button>
  );
}
