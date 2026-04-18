/**
 * Depart-time dropdown — ships with only "Now" active; `Leave at…` and
 * `Arrive by…` surface as disabled options. Chunk-7 deferral — backend
 * already accepts a `date_time`, but the UI is held back until the
 * full time picker lands.
 */
import React from 'react';
import { ChevronDown, Clock } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const DepartMenu: React.FC = () => (
  <DropdownMenu>
    <DropdownMenuTrigger
      aria-label="Depart time"
      className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/40 bg-card/60 px-3 py-1.5 text-xs text-foreground hover:bg-card"
    >
      <Clock size={12} className="shrink-0 text-muted-foreground" />
      <span className="truncate">Now</span>
      <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-[12rem]">
      <DropdownMenuLabel>Depart</DropdownMenuLabel>
      <DropdownMenuItem className="flex items-center justify-between" aria-current="true">
        Now
        <span className="text-[10px] uppercase tracking-wider text-primary">active</span>
      </DropdownMenuItem>
      <DropdownMenuItem disabled className="flex items-center justify-between">
        Leave at…
        <span className="text-[10px] text-muted-foreground">soon</span>
      </DropdownMenuItem>
      <DropdownMenuItem disabled className="flex items-center justify-between">
        Arrive by…
        <span className="text-[10px] text-muted-foreground">soon</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

export default DepartMenu;
