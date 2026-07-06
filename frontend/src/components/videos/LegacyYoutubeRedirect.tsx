import { Navigate, useLocation } from 'react-router-dom'

/** Permanent client-side redirects from the retired /youtube app into the Videos hub.
 *  Kept forever: old bookmarks, chat blocks, and notification deep-links all point here. */
const LIBRARY_PATHS = new Set(['history', 'playlists', 'watch-later', 'liked', 'offline'])

export function LegacyYoutubeRedirect() {
  const { pathname, search, hash } = useLocation()
  const rest = pathname.replace(/^\/youtube\/?/, '')
  const [head] = rest.split('/', 1)

  let to: string
  if (rest === '' || head === 'discover') to = '/videos/youtube'
  else if (head === 'library') to = '/videos/history'
  else if (LIBRARY_PATHS.has(head)) to = `/videos/${rest}`
  else if (head === 'settings') to = `/videos/${rest}`
  else to = `/videos/youtube/${rest}`

  return <Navigate to={`${to}${search}${hash}`} replace />
}
