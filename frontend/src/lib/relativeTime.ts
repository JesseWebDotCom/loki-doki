// Short, human-friendly timestamps for chat/project lists.
// Recent → "just now" / "5 min ago" / "3 hours ago" / "Yesterday" / "4 days ago";
// older this year → "May 21"; older than this year → "May 21, 2024".

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  if (diff < MINUTE) return 'Just now'
  if (diff < HOUR) {
    const mins = Math.floor(diff / MINUTE)
    return `${mins} min ago`
  }
  if (diff < DAY) {
    const hours = Math.floor(diff / HOUR)
    return `${hours} hour${hours === 1 ? '' : 's'} ago`
  }
  if (diff < 7 * DAY) {
    const days = Math.floor(diff / DAY)
    return days === 1 ? 'Yesterday' : `${days} days ago`
  }

  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}
