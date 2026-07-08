import { Link } from "react-router-dom";
import { Settings, ShieldCheck, LogOut } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { AppLauncherBody } from "./AppLauncher";
import { useAuth } from "@/context/AuthContext";
import { useNavPrefs } from "@/context/NavPreferencesContext";
import { useNotifications } from "@/hooks/useNotifications";
import { cn } from "@/lib/cn";

// The mobile "everything" drawer, opened from the bottom dock's Menu button. It is the
// phone-side stand-in for the desktop LeftSidebar: your profile + account actions up top
// and bottom, with the full app launcher (search + recents + categorized grid) filling the
// middle. Reuses AppLauncherBody so the grid never diverges from the desktop launchpad, and
// the single shared NavPreferences tracker so pins/recents match the sidebar.
export function MobileNavSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user, logout } = useAuth();
  const { pinnedIds, recentIds, pin, unpin } = useNavPrefs();
  const { unreadCount } = useNotifications();

  const close = () => onOpenChange(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-sm gap-0 p-0" showCloseButton={false}>
        <SheetTitle className="sr-only">Menu</SheetTitle>

        {/* Profile header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-4 py-3">
          {user && (
            <>
              <div className="relative shrink-0">
                <UserAvatar user={user} size={40} />
                {unreadCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground ring-2 ring-sidebar">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {user.firstName} {user.lastName}
                </p>
                <p className="truncate text-xs capitalize text-muted-foreground">{user.role}</p>
              </div>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={close}>
            Done
          </Button>
        </div>

        {/* App launcher (search + recents + categorized grid) */}
        <AppLauncherBody
          active={open}
          onClose={close}
          pinnedIds={pinnedIds}
          recentIds={recentIds}
          onPin={pin}
          onUnpin={unpin}
          className="flex-1"
          scrollerClassName="flex-1 min-h-0"
        />

        {/* Account actions */}
        <div className="flex shrink-0 items-center gap-1 border-t border-border/50 px-2 py-2">
          <MobileAccountLink to="/settings" icon={Settings} label="Settings" onNavigate={close} />
          {user?.role === "admin" && (
            <MobileAccountLink to="/admin" icon={ShieldCheck} label="Admin" onNavigate={close} />
          )}
          <button
            type="button"
            onClick={() => {
              close();
              void logout();
            }}
            className="ml-auto flex items-center gap-1.5 rounded-control px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
          >
            <LogOut className="size-4" />
            Sign out
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MobileAccountLink({
  to,
  icon: Icon,
  label,
  onNavigate,
}: {
  to: string;
  icon: typeof Settings;
  label: string;
  onNavigate: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-1.5 rounded-control px-3 py-2 text-sm text-muted-foreground transition-colors",
        "hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      <Icon className="size-4" />
      {label}
    </Link>
  );
}
