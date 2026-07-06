import { tiktokProvider, tiktokStreamSource } from './src/lib/videos/providers/tiktok'
import { matchUrlToProvider } from './src/lib/videos/registry'

const m1 = matchUrlToProvider('https://www.tiktok.com/@khaby.lame/video/7137423965982174469')
const m2 = matchUrlToProvider('https://www.tiktok.com/@khaby.lame')
console.log('match video:', m1?.provider.source, m1?.match)
console.log('match creator:', m2?.provider.source, m2?.match)

const { creator, videos } = await tiktokProvider.getCreator!('khaby.lame')
console.log('creator:', creator.name, '| videos:', videos.items.length, '| cursor:', videos.cursor)
const first = videos.items[0]
console.log('first:', first?.id, '|', first?.title?.slice(0, 50))

if (first) {
  const item = await tiktokProvider.getItem(first.id)
  console.log('getItem:', item?.title?.slice(0, 50), '| dur', item?.durationSec, '| vertical', item?.vertical, '| creator', item?.creator?.name)
  const src = await tiktokStreamSource(first.id)
  console.log('stream:', src ? `${src.url.slice(0, 60)}… referer=${src.headers.Referer}` : 'null')
}
