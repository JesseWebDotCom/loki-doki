import { useCallback, useEffect, useRef, useState } from "react";

export interface AppNotification {
  id: string;
  userId: string | null;
  type: "install_request" | "install_complete" | "download_complete" | "system" | "frigate_event" | "companion_checkin" | "watcher_alert" | "price_alert" | "file_drop" | "service_alert" | "resource_alert";
  payload: string; // JSON string
  priority?: "info" | "normal" | "urgent";
  readAt: number | null;
  createdAt: number;
}

interface UseNotificationsReturn {
  unreadCount: number;
  notifications: AppNotification[];
  loadNotifications: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  clearAll: () => Promise<void>;
}

export function useNotifications(): UseNotificationsReturn {
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchUnreadCount() {
    try {
      const res = await fetch("/api/notifications/unread-count", { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { unreadCount: number };
      setUnreadCount(data.unreadCount);
    } catch {
      // ignore
    }
  }

  const loadNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { notifications: AppNotification[]; unreadCount: number };
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch {
      // ignore
    }
  }, []);

  async function markRead(id: string) {
    try {
      await fetch(`/api/notifications/${id}/read`, {
        method: "PATCH",
        credentials: "include",
      });
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, readAt: Date.now() } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch {
      // ignore
    }
  }

  async function markAllRead() {
    try {
      await fetch("/api/notifications/read-all", {
        method: "POST",
        credentials: "include",
      });
      setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? Date.now() })));
      setUnreadCount(0);
    } catch {
      // ignore
    }
  }

  async function clearAll() {
    try {
      await fetch("/api/notifications", { method: "DELETE", credentials: "include" });
      setNotifications([]);
      setUnreadCount(0);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void fetchUnreadCount();
    // Skip the poll while the tab is hidden (a background tab kept hitting the 2-query
    // /unread-count endpoint every 30s forever), and refresh once when it becomes visible again.
    intervalRef.current = setInterval(() => {
      if (!document.hidden) void fetchUnreadCount();
    }, 30_000);
    const onVisible = () => { if (!document.hidden) void fetchUnreadCount(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { unreadCount, notifications, loadNotifications, markRead, markAllRead, clearAll };
}
