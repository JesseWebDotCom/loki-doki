import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DEFAULT_ICON,
  DEFAULT_SWATCH,
  PROJECT_ICONS,
  SWATCH_TOKENS,
  getIconComponent,
  swatchVar,
} from '@/lib/projectPalette';
import type { ProjectInput } from '@/lib/api';

interface ProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (project: ProjectInput) => void;
  initialData?: Partial<ProjectInput> | null;
  title: string;
}

const ProjectModal: React.FC<ProjectModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  initialData,
  title,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [icon, setIcon] = useState<string>(DEFAULT_ICON);
  const [iconColor, setIconColor] = useState<string>(DEFAULT_SWATCH);

  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [iconSearch, setIconSearch] = useState('');

  const iconPickerRef = useRef<HTMLDivElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialData) {
      setName(initialData.name || '');
      setDescription(initialData.description || '');
      setPrompt(initialData.prompt || '');
      setIcon(initialData.icon || DEFAULT_ICON);
      setIconColor(initialData.icon_color || DEFAULT_SWATCH);
    } else {
      setName('');
      setDescription('');
      setPrompt('');
      setIcon(DEFAULT_ICON);
      setIconColor(DEFAULT_SWATCH);
    }
    setShowIconPicker(false);
    setShowColorPicker(false);
    setIconSearch('');
  }, [initialData, isOpen]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (iconPickerRef.current && !iconPickerRef.current.contains(e.target as Node)) {
        setShowIconPicker(false);
      }
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ name, description, prompt, icon, icon_color: iconColor });
    onClose();
  };

  const IconPreview = getIconComponent(icon);
  const filteredIcons = PROJECT_ICONS.filter((n) =>
    n.toLowerCase().includes(iconSearch.toLowerCase()),
  );

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/30"
              style={{
                color: swatchVar(iconColor),
                backgroundColor: `color-mix(in oklch, ${swatchVar(iconColor)} 14%, transparent)`,
              }}
            >
              <IconPreview className="h-4 w-4" />
            </div>
            {title}
          </DialogTitle>
          <DialogDescription>
            Configure your project's persona, icon, and color.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 py-2">
          <div className="space-y-2">
            <Label htmlFor="name">Project Name</Label>
            <Input
              id="name"
              placeholder="e.g. Code Refactor, Pirate World"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              placeholder="Brief description of this project's goals"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="prompt">Custom Instructions (System Prompt)</Label>
            <textarea
              id="prompt"
              className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Set rules, tone, or context for chats inside this project..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Icon picker */}
            <div className="space-y-2 relative" ref={iconPickerRef}>
              <Label>Icon</Label>
              <button
                type="button"
                onClick={() => {
                  setShowIconPicker((v) => !v);
                  setShowColorPicker(false);
                }}
                className="flex w-full items-center gap-3 rounded-md border border-input bg-background px-2 py-2 hover:bg-accent/30 transition-colors"
              >
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-border/30"
                  style={{ color: swatchVar(iconColor) }}
                >
                  <IconPreview className="h-4 w-4" />
                </div>
                <span className="flex-1 text-left text-sm text-foreground truncate">{icon}</span>
                {showIconPicker ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>

              {showIconPicker && (
                <div className="absolute bottom-full left-0 mb-2 w-72 rounded-lg border border-border bg-popover p-3 shadow-m4 z-[60]">
                  <div className="relative mb-3">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      autoFocus
                      value={iconSearch}
                      onChange={(e) => setIconSearch(e.target.value)}
                      placeholder="Search icons..."
                      className="pl-8 h-9 text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-6 gap-1 max-h-[220px] overflow-y-auto pr-1">
                    {filteredIcons.map((iconName) => {
                      const Icon = getIconComponent(iconName);
                      const selected = iconName === icon;
                      return (
                        <button
                          key={iconName}
                          type="button"
                          title={iconName}
                          onClick={() => {
                            setIcon(iconName);
                            setShowIconPicker(false);
                          }}
                          className={
                            'flex items-center justify-center rounded-md p-2 transition-colors ' +
                            (selected
                              ? 'bg-primary/15 text-primary'
                              : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground')
                          }
                        >
                          <Icon className="h-4 w-4" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Color picker */}
            <div className="space-y-2 relative" ref={colorPickerRef}>
              <Label>Icon Color</Label>
              <button
                type="button"
                onClick={() => {
                  setShowColorPicker((v) => !v);
                  setShowIconPicker(false);
                }}
                className="flex w-full items-center gap-3 rounded-md border border-input bg-background px-2 py-2 hover:bg-accent/30 transition-colors"
              >
                <div
                  className="h-8 w-8 rounded-md border border-border/30"
                  style={{ backgroundColor: swatchVar(iconColor) }}
                />
                <span className="flex-1 text-left text-sm font-mono text-foreground">{iconColor}</span>
                {showColorPicker ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>

              {showColorPicker && (
                <div className="absolute bottom-full right-0 mb-2 w-[200px] rounded-lg border border-border bg-popover p-3 shadow-m4 z-[60]">
                  <div className="mb-2 px-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Theme palette
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {SWATCH_TOKENS.map((token) => {
                      const selected = token === iconColor;
                      return (
                        <button
                          key={token}
                          type="button"
                          title={token}
                          onClick={() => {
                            setIconColor(token);
                            setShowColorPicker(false);
                          }}
                          className={
                            'h-8 w-8 rounded-full border transition-transform hover:scale-110 active:scale-95 ' +
                            (selected
                              ? 'border-foreground ring-2 ring-primary ring-offset-2 ring-offset-popover'
                              : 'border-border/40')
                          }
                          style={{ backgroundColor: swatchVar(token) }}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save Project</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default ProjectModal;
