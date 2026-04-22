import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import type { ChatSearchResult } from "../../../lib/api-types";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import SearchResultItem from "./SearchResultItem";

interface SearchDialogProps {
  open: boolean;
  query: string;
  results: ChatSearchResult[];
  loading?: boolean;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onSelectResult: (result: ChatSearchResult) => void;
}

export default function SearchDialog({
  open,
  query,
  results,
  loading = false,
  onOpenChange,
  onQueryChange,
  onSelectResult,
}: SearchDialogProps) {
  const [draft, setDraft] = useState(query);

  useEffect(() => {
    setDraft(query);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      onQueryChange(draft.trim());
    }, 200);
    return () => window.clearTimeout(timer);
  }, [draft, onQueryChange, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-hidden rounded-[2rem] p-0">
        <DialogHeader className="border-b border-border/40 px-6 py-5">
          <DialogTitle>Search all chats</DialogTitle>
          <DialogDescription>
            Local transcript search powered by the on-device SQLite history.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 py-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Search every chat"
              className="h-11 rounded-2xl pl-10"
              aria-label="Search all chats"
            />
          </div>
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {loading ? (
              <p className="text-sm text-muted-foreground">Searching locally…</p>
            ) : null}
            {!loading && draft.trim().length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Type a phrase to search across your local chat history.
              </p>
            ) : null}
            {!loading && draft.trim().length > 0 && results.length === 0 ? (
              <p className="text-sm text-muted-foreground">No chats matched.</p>
            ) : null}
            {results.map((result) => (
              <SearchResultItem
                key={`${result.session_id}-${result.message_id}`}
                result={result}
                onSelect={() => onSelectResult(result)}
              />
            ))}
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-2xl px-4"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
