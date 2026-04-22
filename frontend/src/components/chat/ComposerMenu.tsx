import React from 'react';
import { Plus, Check } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  TOGGLE_MODES,
  type ToggleMode,
} from './modeToggleOptions';

const MODE_LABEL: Record<ToggleMode, string> = {
  auto: 'Auto',
  simple: 'Simple',
  rich: 'Rich',
};

interface ComposerMenuProps {
  mode: ToggleMode;
  disabled?: boolean;
  onSelectMode: (mode: ToggleMode) => void;
}

const ComposerMenu: React.FC<ComposerMenuProps> = ({
  mode,
  disabled = false,
  onSelectMode,
}) => {
  const modeForced = mode !== 'auto';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Response mode"
          title="Response mode"
          className={`flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2 transition hover:bg-card disabled:cursor-not-allowed disabled:opacity-50 ${
            modeForced
              ? 'text-primary'
              : 'text-muted-foreground/70 hover:text-foreground'
          }`}
        >
          <Plus size={18} />
          <span className="text-[11px] font-bold uppercase tracking-widest">
            {MODE_LABEL[mode]}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel>Response mode</DropdownMenuLabel>
        {TOGGLE_MODES.map((m) => (
          <DropdownMenuItem
            key={m}
            onSelect={() => onSelectMode(m)}
            className="flex items-center justify-between py-2"
          >
            <span className="text-sm">{MODE_LABEL[m]}</span>
            {m === mode ? <Check className="h-4 w-4 text-primary" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ComposerMenu;
