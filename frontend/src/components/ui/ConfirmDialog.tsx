import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Button } from './button';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  confirmHint?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Hide the Cancel button — turns this into an alert/acknowledge dialog. */
  hideCancel?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * App-wide modal confirmation. Replace any `window.confirm` call with this.
 * Browser dialogs are forbidden in this codebase — see CLAUDE.md.
 */
const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmText,
  confirmHint,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  hideCancel = false,
  onConfirm,
  onCancel,
}) => {
  const [typedValue, setTypedValue] = useState('');
  const requiresPhrase = Boolean(confirmText);
  const normalizedTypedValue = typedValue.trim().toUpperCase();
  const normalizedConfirmText = (confirmText || '').trim().toUpperCase();
  const confirmDisabled = requiresPhrase && normalizedTypedValue !== normalizedConfirmText;

  useEffect(() => {
    if (!open) {
      setTypedValue('');
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {requiresPhrase && (
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">
              Type <span className="font-semibold text-foreground">{confirmText}</span> to continue.
            </div>
            <input
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder={confirmHint || confirmText}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              aria-label="confirmation text"
              autoFocus
            />
          </div>
        )}
        <DialogFooter>
          {!hideCancel && (
            <Button variant="outline" onClick={onCancel}>
              {cancelLabel}
            </Button>
          )}
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ConfirmDialog;
