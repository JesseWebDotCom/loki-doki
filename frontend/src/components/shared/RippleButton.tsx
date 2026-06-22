import { useCallback, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/cn'

interface Ripple { id: number; x: number; y: number }

export interface RippleButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  rippleColor?: string
  hoverScale?: number
  tapScale?: number
  children?: ReactNode
}

export function RippleButton({
  className,
  onClick,
  rippleColor = 'currentColor',
  hoverScale = 1.05,
  tapScale = 0.95,
  disabled,
  children,
  ...props
}: RippleButtonProps) {
  const [ripples, setRipples] = useState<Ripple[]>([])
  const ref = useRef<HTMLButtonElement>(null)

  const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return
    const btn = ref.current
    if (btn) {
      const rect = btn.getBoundingClientRect()
      const id = Date.now()
      setRipples(prev => [...prev, { id, x: e.clientX - rect.left, y: e.clientY - rect.top }])
      setTimeout(() => setRipples(prev => prev.filter(r => r.id !== id)), 600)
    }
    onClick?.(e)
  }, [disabled, onClick])

  return (
    <motion.button
      ref={ref}
      className={cn('relative overflow-hidden', className)}
      whileHover={disabled ? undefined : { scale: hoverScale }}
      whileTap={disabled ? undefined : { scale: tapScale }}
      onClick={handleClick}
      disabled={disabled}
      {...(props as object)}
    >
      {children}
      {ripples.map(r => (
        <motion.span
          key={r.id}
          initial={{ scale: 0, opacity: 0.5 }}
          animate={{ scale: 10, opacity: 0 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="absolute size-5 rounded-full pointer-events-none"
          style={{ backgroundColor: rippleColor, top: r.y - 10, left: r.x - 10 }}
        />
      ))}
    </motion.button>
  )
}
