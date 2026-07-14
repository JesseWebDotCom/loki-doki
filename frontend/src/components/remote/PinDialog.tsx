import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

// Re-auth prompt for the dangerous System actions (unsandbox toggle, host shell). The
// caller does the actual verification server-side; this just collects the PIN.
export function PinDialog({ open, onOpenChange, title, description, onSubmit }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: string
  onSubmit: (pin: string) => void
}) {
  const [pin, setPin] = useState('')
  useEffect(() => { if (open) setPin('') }, [open])
  const submit = () => { if (pin) { onSubmit(pin); onOpenChange(false) } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <Input
          type="password"
          inputMode="numeric"
          autoFocus
          placeholder="Admin PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!pin}>Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
