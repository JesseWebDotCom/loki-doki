/**
 * Avoid dropdown — shadcn DropdownMenu over a three-checkbox set
 * (highways / tolls / ferries). Backing state lives in the parent so
 * the hook can re-fire the route fetch.
 */
import React from 'react';
import { Ban, Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AvoidState } from './DirectionsPanel.types';

export interface AvoidMenuProps {
  value: AvoidState;
  onChange: (next: AvoidState) => void;
}

const ITEMS: { key: keyof AvoidState; label: string }[] = [
  { key: 'highways', label: 'Highways' },
  { key: 'tolls', label: 'Tolls' },
  { key: 'ferries', label: 'Ferries' },
];

const AvoidMenu: React.FC<AvoidMenuProps> = ({ value, onChange }) => {
  const anyOn = value.highways || value.tolls || value.ferries;
  const summary = anyOn
    ? ITEMS.filter((i) => value[i.key])
        .map((i) => i.label)
        .join(', ')
    : 'Avoid';

  const toggle = (key: keyof AvoidState) => {
    onChange({ ...value, [key]: !value[key] });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Avoid options"
        className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/40 bg-card/60 px-3 py-1.5 text-xs text-foreground hover:bg-card"
      >
        <Ban size={12} className="shrink-0 text-muted-foreground" />
        <span className="truncate">{summary}</span>
        <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        <DropdownMenuLabel>Avoid</DropdownMenuLabel>
        {ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitemcheckbox"
            aria-checked={value[item.key]}
            onClick={() => toggle(item.key)}
            className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm text-foreground outline-none hover:bg-primary/10 focus:bg-primary/10 focus:text-primary"
          >
            <span
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border/60 bg-background"
              aria-hidden
            >
              {value[item.key] && <Check size={11} />}
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default AvoidMenu;
