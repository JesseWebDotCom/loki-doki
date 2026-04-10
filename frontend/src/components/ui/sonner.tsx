import { useTheme } from '../theme/ThemeProvider';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme();
  const resolvedTheme = theme === 'system' ? 'system' : theme;

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast border-border/40 bg-card text-card-foreground shadow-m4 backdrop-blur-xl',
          title: 'text-sm font-semibold',
          description: 'text-sm text-muted-foreground',
          actionButton:
            'bg-primary text-primary-foreground hover:bg-primary/90',
          cancelButton:
            'bg-muted text-muted-foreground hover:bg-muted/90',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
