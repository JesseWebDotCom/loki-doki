import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Settings, ShieldCheck, LogOut, FlaskConical } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { TesterDialog } from "@/components/diagnostics/TesterDialog";
import { useAuth } from "@/context/AuthContext";
import type { useNotifications } from "@/hooks/useNotifications";
import { notifIcon, notifLabel, timeAgo } from "@/lib/notifications";
import { cn } from "@/lib/cn";

// The "You" tab sheet: profile + notifications + account actions. This is the
// account half of the retired MobileNavSheet (the launcher half now lives behind
// the Search tab / Spotlight). Notifications reuse the sidebar dropdown's row
// idiom so the two surfaces never diverge.
export function MobileYouSheet({
  open,
  onOpenChange,
  notif,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dock's single useNotifications instance (a second one would desync the badge). */
  notif: ReturnType<typeof useNotifications>;
}) {
  const { user, logout } = useAuth();
  const { unreadCount, notifications, loadNotifications, markRead, markAllRead } = notif;
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [testerOpen, setTesterOpen] = useState(false);

  useEffect(() => {
    if (open) void loadNotifications();
  }, [open, loadNotifications]);

  const close = () => onOpenChange(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-sm gap-0 p-0" showCloseButton={false}>
        <SheetTitle className="sr-only">You</SheetTitle>

        {/* Profile header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-4 py-3">
          {user && (
            <>
              <UserAvatar user={user} size={40} />
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

        {/* Notifications */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between px-4 pb-1 pt-3">
            <span className="text-xs font-semibold text-foreground">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="text-caption text-muted-foreground transition-colors hover:text-foreground"
              >
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">No notifications</p>
          ) : (
            notifications.slice(0, 12).map((n) => {
              const NIcon = notifIcon(n.type);
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    if (!n.readAt) void markRead(n.id);
                  }}
                  className={cn(
                    "flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-foreground/5",
                    !n.readAt && "bg-brand/5",
                  )}
                >
                  <NIcon className={cn("mt-0.5 size-4 shrink-0", n.readAt ? "text-muted-foreground" : "text-brand")} />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-sm leading-snug", !n.readAt && "font-medium")}>
                      {notifLabel(n)}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{timeAgo(n.createdAt)}</span>
                  </span>
                  {!n.readAt && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" />}
                </button>
              );
            })
          )}
        </div>

        {/* Account actions */}
        <div className="flex shrink-0 items-center gap-1 border-t border-border/50 px-2 py-2">
          <AccountLink to="/settings" icon={Settings} label="Settings" onNavigate={close} />
          {user?.role === "admin" && <AccountLink to="/admin" icon={ShieldCheck} label="Admin" onNavigate={close} />}
          <button
            type="button"
            onClick={() => setTesterOpen(true)}
            className={cn(
              "flex items-center gap-1.5 rounded-control px-3 py-2 text-sm text-muted-foreground transition-colors",
              "hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            <FlaskConical className="size-4" />
            Tester
          </button>
          <button
            type="button"
            onClick={() => setConfirmSignOut(true)}
            className="ml-auto flex items-center gap-1.5 rounded-control px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
          >
            <LogOut className="size-4" />
            Sign out
          </button>
        </div>

        <TesterDialog open={testerOpen} onOpenChange={setTesterOpen} />
        <ConfirmDialog
          open={confirmSignOut}
          onOpenChange={setConfirmSignOut}
          title="Sign out?"
          description="You'll return to the profile picker."
          confirmLabel="Sign out"
          destructive
          onConfirm={() => {
            close();
            void logout();
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

function AccountLink({
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
