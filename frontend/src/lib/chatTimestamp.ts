export function createMessageTimestamp(now: Date = new Date()): string {
  return now.toISOString();
}

export function formatMessageTime(timestamp: string): string {
  const parsed = parseMessageTimestamp(timestamp);
  if (!parsed) return timestamp;
  return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatMessageDateTime(timestamp: string): string {
  const parsed = parseMessageTimestamp(timestamp);
  if (!parsed) return timestamp;
  return parsed.toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function parseMessageTimestamp(timestamp: string): Date | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}
