import * as React from "react";
import { Popover } from "radix-ui";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { Badge, type BadgeProps } from "@/components/ui/badge";

export interface RichOption {
  value: string;
  label: string;
  description?: string;
  badges?: Array<{
    text: string;
    variant?: BadgeProps["variant"];
  }>;
  recommended?: boolean;
  disabled?: boolean;
}

export interface RichOptionGroup {
  label?: string;
  options: RichOption[];
}

interface RichOptionSelectProps {
  value: string;
  onChange: (value: string) => void;
  groups: RichOptionGroup[];
  placeholder?: string;
  triggerClassName?: string;
  disabled?: boolean;
}

export function RichOptionSelect({
  value,
  onChange,
  groups,
  placeholder = "Select an option…",
  triggerClassName,
  disabled,
}: RichOptionSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const allOptions = groups.flatMap((g) => g.options);
  const selected = allOptions.find((o) => o.value === value);

  const filteredGroups = query
    ? groups
        .map((g) => ({
          ...g,
          options: g.options.filter(
            (o) =>
              o.label.toLowerCase().includes(query.toLowerCase()) ||
              o.description?.toLowerCase().includes(query.toLowerCase()),
          ),
        }))
        .filter((g) => g.options.length > 0)
    : groups;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <button
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          className={cn(
            "flex h-10 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm",
            "hover:bg-accent hover:text-accent-foreground",
            "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
            "disabled:cursor-not-allowed disabled:opacity-50",
            triggerClassName,
          )}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            {selected ? (
              <>
                <span className="truncate font-medium">{selected.label}</span>
                {selected.badges?.slice(0, 2).map((b) => (
                  <Badge key={b.text} variant={b.variant ?? "secondary"} className="shrink-0">
                    {b.text}
                  </Badge>
                ))}
              </>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className={cn(
            "z-50 w-[var(--radix-popover-trigger-width)] rounded-md border bg-popover shadow-md outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
          sideOffset={4}
          align="start"
        >
          {allOptions.length > 5 && (
            <div className="border-b p-2">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="w-full bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
                autoFocus
              />
            </div>
          )}

          <div className="max-h-[320px] overflow-y-auto p-1" role="listbox">
            {filteredGroups.map((group, gi) => (
              <div key={gi}>
                {group.label && (
                  <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </p>
                )}
                {group.options.map((option) => (
                  <button
                    key={option.value}
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={cn(
                      "flex w-full cursor-pointer items-start gap-3 rounded-sm px-2 py-2.5 text-left text-sm outline-none transition-colors",
                      "hover:bg-accent hover:text-accent-foreground",
                      "focus:bg-accent focus:text-accent-foreground",
                      "disabled:pointer-events-none disabled:opacity-50",
                    )}
                  >
                    <Check
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        option.value === value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium leading-none">{option.label}</span>
                        {option.recommended && (
                          <Badge variant="info" className="text-[10px]">Recommended</Badge>
                        )}
                        {option.badges?.map((b) => (
                          <Badge key={b.text} variant={b.variant ?? "secondary"} className="text-[10px]">
                            {b.text}
                          </Badge>
                        ))}
                      </div>
                      {option.description && (
                        <p className="text-xs leading-snug text-muted-foreground">
                          {option.description}
                        </p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            ))}

            {filteredGroups.length === 0 && (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">No results found.</p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
