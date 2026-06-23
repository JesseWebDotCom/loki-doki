import { useCallback, useEffect, useRef, useState } from "react";

export interface AppNotification {
  id: string;
  userId: string | null;
  type: "install_request" | "install_complete" | "download_complete" | "system" | "frigate_event";
  payload: string; // JSON string
  readAt: number | null;
  createdAt: number;
}

interface UseNotificationsReturn {
  unreadCount: number;
  notifications: AppNotification[];
  loadNotifications: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
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

  useEffect(() => {
    void fetchUnreadCount();
    intervalRef.current = setInterval(() => { void fetchUnreadCount(); }, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { unreadCount, notifications, loadNotifications, markRead, markAllRead };
}
