import { Toaster } from 'sonner'
import { useTheme } from '@/context/ThemeContext'

// App-wide toast surface. Mounted once; call `toast(...)` from 'sonner' anywhere.
// Mirrors the app's resolved light/dark theme so toasts match the chrome.
export function AppToaster() {
  const { effectiveTheme } = useTheme()
  return (
    <Toaster
      theme={effectiveTheme}
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{ className: 'rounded-xl' }}
    />
  )
}
