// Demo household fixture data for documentation screenshots ("the Parkers").
//
// Everything here is fictional-identity + real-public-content by design: personas are
// invented people with a generic location, but the media they "watch/listen/read" is
// real, well-known public content so screenshots look authentic. Never put the owner's
// real name, family members, city, or history in this file — docs screenshots are taken
// exclusively as these users (see scripts/seed-demo.ts and the /update-docs skill).
//
// IDs: every row seeded from this file uses a `demo-` prefixed primary key (or one of
// the fixed DEMO_USER_IDS UUIDs), which is what teardown keys on for shared tables.

// Fixed UUIDs = deterministic upsert key, teardown key, AND the screenshot engine's
// "this session really is a demo user" guard (it requires the dde30000- prefix).
export const DEMO_USER_IDS = {
  sam: 'dde30000-0000-4000-8000-000000000001',
  riley: 'dde30000-0000-4000-8000-000000000002',
  jamie: 'dde30000-0000-4000-8000-000000000003',
  rose: 'dde30000-0000-4000-8000-000000000004',
} as const

export type PersonaKey = keyof typeof DEMO_USER_IDS

// All demo users share a generic location so weather/briefing/ticker widgets (which
// render live server data keyed off this pref) never show the owner's real town.
export const DEMO_LOCATION = { displayName: 'Portland, Oregon', lat: 45.5152, lng: -122.6784 }

export interface DemoTrack { videoId: string; title: string; artist: string; durationSec: number }
export interface DemoChannel { externalId: string; title: string; handle?: string }
export interface DemoVideo { videoId: string; title: string; author: string; durationSec: number }
export interface DemoWatchlistItem { mediaType: 'show' | 'movie'; refId: string; title: string; subtitle?: string; status: 'want' | 'watching' | 'completed' }
export interface DemoBook { id: string; title: string; author: string; isbn?: string; publishedYear?: number; progress?: number }
export interface DemoBookmark { url: string; title: string; siteName: string; category: string; collection?: string }
export interface DemoRadio { name: string; streamUrl: string; tags: string; country: string }
export interface DemoFeed { url: string; title: string; siteUrl: string }
export interface DemoChat { title: string; turns: { role: 'user' | 'assistant'; content: string }[] }

export interface DemoPersona {
  key: PersonaKey
  id: string
  firstName: string
  lastName: string
  nickname: string
  birthdate: string
  role: 'admin' | 'user'
  profileSlug: 'locked' | 'teen' | 'adult' | 'unrestricted'
  pin?: string
  avatarSeed: string
  companionName: string
  lockedHomeLayout?: boolean
  toolDenials: string[]
  ytSubscriptions: DemoChannel[]
  watchLater: DemoVideo[]
  watchProgress: { videoId: string; positionSec: number; completed?: boolean }[]
  watchlist: DemoWatchlistItem[]
  musicPlaylist?: { name: string; description: string; tracks: DemoTrack[] }
  musicStation?: { name: string; description: string; aiPrompt: string; seedType: 'prompt' | 'genre'; seedValue?: string }
  musicFavorites: DemoTrack[]
  musicHistory: { track: DemoTrack; positionSec: number }[]
  radioStations: DemoRadio[]
  books: DemoBook[]
  bookmarkCollection?: { name: string; icon?: string }
  bookmarks: DemoBookmark[]
  personalFeeds: DemoFeed[]
  chat?: DemoChat
  memory?: { text: string; category: 'preference' | 'fact'; tier: 'durable' | 'episodic' }
  notifications: { message: string; priority: 'info' | 'normal' }[]
}

// Well-known music videos with correct titles/artists — thumbnails derive from videoId.
const T = {
  bohemian: { videoId: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen', durationSec: 359 },
  teenSpirit: { videoId: 'hTWKbfoikeg', title: 'Smells Like Teen Spirit', artist: 'Nirvana', durationSec: 279 },
  allStar: { videoId: 'L_jWHffIx5E', title: 'All Star', artist: 'Smash Mouth', durationSec: 237 },
  nggyu: { videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley', durationSec: 213 },
  uptownFunk: { videoId: 'OPf0YbXqDm0', title: 'Uptown Funk', artist: 'Mark Ronson ft. Bruno Mars', durationSec: 270 },
  hello: { videoId: 'YQHsXMglC9A', title: 'Hello', artist: 'Adele', durationSec: 367 },
  shakeItOff: { videoId: 'nfWlot6h_JM', title: 'Shake It Off', artist: 'Taylor Swift', durationSec: 242 },
  blankSpace: { videoId: 'e-ORhEE9VVg', title: 'Blank Space', artist: 'Taylor Swift', durationSec: 271 },
  roar: { videoId: 'CevxZvSJLk8', title: 'Roar', artist: 'Katy Perry', durationSec: 269 },
  believer: { videoId: '7wtfhZwyrcc', title: 'Believer', artist: 'Imagine Dragons', durationSec: 216 },
  radioactive: { videoId: 'ktvTqknDobU', title: 'Radioactive', artist: 'Imagine Dragons', durationSec: 187 },
  faded: { videoId: '60ItHLz5WEA', title: 'Faded', artist: 'Alan Walker', durationSec: 212 },
  babyShark: { videoId: 'XqZsoesa55w', title: 'Baby Shark Dance', artist: 'Pinkfong', durationSec: 136 },
  perfect: { videoId: '2Vv-BfVoq4g', title: 'Perfect', artist: 'Ed Sheeran', durationSec: 283 },
  seeYouAgain: { videoId: 'RgKAFK5djSk', title: 'See You Again', artist: 'Wiz Khalifa ft. Charlie Puth', durationSec: 238 },
} satisfies Record<string, DemoTrack>

export const DEMO_PERSONAS: DemoPersona[] = [
  {
    key: 'sam',
    id: DEMO_USER_IDS.sam,
    firstName: 'Sam',
    lastName: 'Parker',
    nickname: 'Sam',
    birthdate: '1984-05-12',
    role: 'admin',
    profileSlug: 'adult',
    pin: '0000',
    avatarSeed: 'demo-sam',
    companionName: 'Sage',
    toolDenials: [],
    ytSubscriptions: [
      { externalId: 'UCHnyfMqiRRG1u-2MsSQLbXA', title: 'Veritasium', handle: '@veritasium' },
      { externalId: 'UCBJycsmduvYEL83R_U4JriQ', title: 'Marques Brownlee', handle: '@mkbhd' },
      { externalId: 'UCsXVk37bltHxD1rDPwtNM8Q', title: 'Kurzgesagt – In a Nutshell', handle: '@kurzgesagt' },
      { externalId: 'UCYO_jab_esuFRV4b17AJtAw', title: '3Blue1Brown', handle: '@3blue1brown' },
    ],
    watchLater: [
      { videoId: 'aircAruvnKk', title: 'But what is a neural network?', author: '3Blue1Brown', durationSec: 1140 },
      { videoId: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody (Official Video)', author: 'Queen Official', durationSec: 359 },
    ],
    watchProgress: [
      { videoId: 'aircAruvnKk', positionSec: 412 },
      { videoId: 'OPf0YbXqDm0', positionSec: 270, completed: true },
    ],
    watchlist: [
      { mediaType: 'show', refId: '44913', title: 'Severance', subtitle: 'Apple TV+', status: 'watching' },
      { mediaType: 'show', refId: '60180', title: 'The Bear', subtitle: 'FX', status: 'want' },
      { mediaType: 'movie', refId: 'Dune: Part Two', title: 'Dune: Part Two', subtitle: '2024', status: 'want' },
      { mediaType: 'movie', refId: 'Oppenheimer', title: 'Oppenheimer', subtitle: '2023', status: 'completed' },
    ],
    musicPlaylist: {
      name: 'Road Trip Classics',
      description: 'Windows down, volume up.',
      tracks: [T.bohemian, T.teenSpirit, T.allStar, T.nggyu],
    },
    musicStation: {
      name: '90s Alt Rock',
      description: 'Grunge and alternative from the flannel decade.',
      aiPrompt: '90s alternative rock and grunge — Nirvana, Pearl Jam, Soundgarden era.',
      seedType: 'genre',
      seedValue: 'alternative rock',
    },
    musicFavorites: [T.bohemian, T.uptownFunk],
    musicHistory: [
      { track: T.hello, positionSec: 190 },
      { track: T.uptownFunk, positionSec: 270 },
    ],
    radioStations: [],
    books: [
      { id: 'demo-book-hail-mary', title: 'Project Hail Mary', author: 'Andy Weir', isbn: '9780593135204', publishedYear: 2021 },
      { id: 'demo-book-atomic-habits', title: 'Atomic Habits', author: 'James Clear', isbn: '9780735211292', publishedYear: 2018, progress: 0.3 },
    ],
    bookmarkCollection: { name: 'Cooking' },
    bookmarks: [
      { url: 'https://www.seriouseats.com', title: 'Serious Eats', siteName: 'Serious Eats', category: 'Food', collection: 'Cooking' },
      { url: 'https://www.allrecipes.com', title: 'Allrecipes', siteName: 'Allrecipes', category: 'Food', collection: 'Cooking' },
      { url: 'https://www.nasa.gov', title: 'NASA', siteName: 'NASA', category: 'Science' },
    ],
    personalFeeds: [],
    chat: {
      title: 'Weekend hike planning',
      turns: [
        { role: 'user', content: 'We’re thinking about a family hike this weekend — somewhere easy enough for the kids.' },
        { role: 'assistant', content: 'Nice! For an easy family outing, look for a loop under 3 miles with little elevation gain. Pack layers — the forecast shows a cool morning warming up by noon. Want me to set a reminder to prep snacks and water bottles Friday evening?' },
        { role: 'user', content: 'Yes, remind us Friday at 6pm. And add trail mix to the shopping list.' },
        { role: 'assistant', content: 'Done — reminder set for Friday at 6:00 PM, and trail mix is on the list. Have a great hike!' },
      ],
    },
    memory: { text: 'Plans family activities for the weekend and likes easy kid-friendly trails.', category: 'preference', tier: 'durable' },
    notifications: [
      { message: 'Nightly backup completed successfully', priority: 'info' },
      { message: 'A new app update is ready to install', priority: 'normal' },
    ],
  },
  {
    key: 'riley',
    id: DEMO_USER_IDS.riley,
    firstName: 'Riley',
    lastName: 'Parker',
    nickname: 'Riley',
    birthdate: '2011-02-03',
    role: 'user',
    profileSlug: 'teen',
    avatarSeed: 'demo-riley',
    companionName: 'Pixel',
    toolDenials: ['shopping'],
    ytSubscriptions: [
      { externalId: 'UCX6OQ3DkcsbYNE6H8uQQuVA', title: 'MrBeast', handle: '@mrbeast' },
      { externalId: 'demo-ch-dude-perfect', title: 'Dude Perfect', handle: '@dudeperfect' },
      { externalId: 'UCsooa4yRKGN_zEE8iknghZA', title: 'TED-Ed', handle: '@teded' },
      { externalId: 'UCLA_DiR1FfKNvjuUpBHmylQ', title: 'NASA', handle: '@nasa' },
    ],
    watchLater: [
      { videoId: '7wtfhZwyrcc', title: 'Believer (Official Music Video)', author: 'Imagine Dragons', durationSec: 216 },
      { videoId: '60ItHLz5WEA', title: 'Faded', author: 'Alan Walker', durationSec: 212 },
    ],
    watchProgress: [{ videoId: '7wtfhZwyrcc', positionSec: 95 }],
    watchlist: [
      { mediaType: 'show', refId: '555', title: 'Avatar: The Last Airbender', subtitle: 'Nickelodeon', status: 'watching' },
      { mediaType: 'show', refId: '2993', title: 'Stranger Things', subtitle: 'Netflix', status: 'want' },
      { mediaType: 'movie', refId: 'Spider-Man: Across the Spider-Verse', title: 'Spider-Man: Across the Spider-Verse', subtitle: '2023', status: 'completed' },
    ],
    musicPlaylist: {
      name: 'Study Beats',
      description: 'Background music for homework.',
      tracks: [T.faded, T.believer, T.blankSpace, T.seeYouAgain],
    },
    musicFavorites: [T.believer, T.radioactive],
    musicHistory: [
      { track: T.faded, positionSec: 120 },
      { track: T.shakeItOff, positionSec: 242 },
    ],
    radioStations: [],
    books: [
      { id: 'demo-book-hunger-games', title: 'The Hunger Games', author: 'Suzanne Collins', isbn: '9780439023481', publishedYear: 2008, progress: 0.62 },
      { id: 'demo-book-lightning-thief', title: 'The Lightning Thief', author: 'Rick Riordan', isbn: '9780786838653', publishedYear: 2005 },
    ],
    bookmarks: [
      { url: 'https://www.khanacademy.org', title: 'Khan Academy', siteName: 'Khan Academy', category: 'Learning' },
      { url: 'https://www.duolingo.com', title: 'Duolingo', siteName: 'Duolingo', category: 'Learning' },
    ],
    personalFeeds: [],
    chat: {
      title: 'Algebra homework help',
      turns: [
        { role: 'user', content: 'Can you help me understand how to solve 3x + 7 = 22?' },
        { role: 'assistant', content: 'Sure! The goal is to get x by itself. First subtract 7 from both sides: 3x = 15. Then divide both sides by 3: x = 5. Want to try one on your own to check that it clicks?' },
        { role: 'user', content: 'Ok what about 2x - 4 = 10?' },
        { role: 'assistant', content: 'Walk it through: add 4 to both sides to get 2x = 14, then divide by 2… so x = 7. You’ve got it!' },
      ],
    },
    memory: { text: 'Working through pre-algebra this year and likes step-by-step explanations.', category: 'fact', tier: 'durable' },
    notifications: [{ message: 'Your playlist “Study Beats” is ready for offline listening', priority: 'info' }],
  },
  {
    key: 'jamie',
    id: DEMO_USER_IDS.jamie,
    firstName: 'Jamie',
    lastName: 'Parker',
    nickname: 'Jamie',
    birthdate: '2017-09-21',
    role: 'user',
    profileSlug: 'locked',
    avatarSeed: 'demo-jamie',
    companionName: 'Sprout',
    lockedHomeLayout: true,
    toolDenials: ['shopping', 'coding'],
    ytSubscriptions: [
      { externalId: 'demo-ch-art-for-kids', title: 'Art for Kids Hub', handle: '@artforkidshub' },
      { externalId: 'demo-ch-scishow-kids', title: 'SciShow Kids', handle: '@scishowkids' },
      { externalId: 'demo-ch-natgeo-kids', title: 'Nat Geo Kids', handle: '@natgeokids' },
    ],
    watchLater: [
      { videoId: 'XqZsoesa55w', title: 'Baby Shark Dance', author: 'Pinkfong Baby Shark', durationSec: 136 },
    ],
    watchProgress: [{ videoId: 'XqZsoesa55w', positionSec: 60 }],
    watchlist: [
      { mediaType: 'show', refId: '35256', title: 'Bluey', subtitle: 'ABC Kids', status: 'watching' },
      { mediaType: 'movie', refId: 'Inside Out 2', title: 'Inside Out 2', subtitle: '2024', status: 'want' },
      { mediaType: 'movie', refId: 'Moana', title: 'Moana', subtitle: '2016', status: 'completed' },
    ],
    musicPlaylist: {
      name: 'Dance Party',
      description: 'Songs to jump around to.',
      tracks: [T.babyShark, T.shakeItOff, T.roar],
    },
    musicFavorites: [T.babyShark],
    musicHistory: [{ track: T.babyShark, positionSec: 136 }],
    radioStations: [],
    books: [
      { id: 'demo-book-dog-man', title: 'Dog Man', author: 'Dav Pilkey', isbn: '9780545581608', publishedYear: 2016, progress: 0.45 },
      { id: 'demo-book-magic-tree-house', title: 'Dinosaurs Before Dark', author: 'Mary Pope Osborne', isbn: '9780679824114', publishedYear: 1992 },
    ],
    bookmarks: [],
    personalFeeds: [],
    chat: {
      title: 'Drawing ideas',
      turns: [
        { role: 'user', content: 'What should I draw today?' },
        { role: 'assistant', content: 'How about a friendly dragon having a picnic? You could give it a tiny sandwich and a checkered blanket. Or a rocket ship zooming past Saturn with its rings!' },
      ],
    },
    notifications: [{ message: 'New episode of Bluey is available', priority: 'info' }],
  },
  {
    key: 'rose',
    id: DEMO_USER_IDS.rose,
    firstName: 'Rose',
    lastName: 'Parker',
    nickname: 'Rose',
    birthdate: '1948-11-02',
    role: 'user',
    profileSlug: 'adult',
    avatarSeed: 'demo-rose',
    companionName: 'Iris',
    toolDenials: [],
    ytSubscriptions: [
      { externalId: 'demo-ch-npr-music', title: 'NPR Music', handle: '@nprmusic' },
      { externalId: 'demo-ch-atk', title: "America's Test Kitchen", handle: '@americastestkitchen' },
      { externalId: 'demo-ch-rick-steves', title: "Rick Steves' Europe", handle: '@ricksteves' },
    ],
    watchLater: [
      { videoId: '2Vv-BfVoq4g', title: 'Perfect (Official Music Video)', author: 'Ed Sheeran', durationSec: 283 },
    ],
    watchProgress: [],
    watchlist: [
      { mediaType: 'show', refId: '32604', title: 'The Great British Bake Off', subtitle: 'Channel 4', status: 'watching' },
      { mediaType: 'movie', refId: 'Casablanca', title: 'Casablanca', subtitle: '1942', status: 'completed' },
      { mediaType: 'movie', refId: "Singin' in the Rain", title: "Singin' in the Rain", subtitle: '1952', status: 'want' },
    ],
    musicFavorites: [T.hello, T.perfect],
    musicHistory: [{ track: T.hello, positionSec: 367 }],
    radioStations: [
      { name: 'WQXR Classical', streamUrl: 'https://stream.wqxr.org/wqxr', tags: 'classical', country: 'The United States Of America' },
      { name: 'Jazz24', streamUrl: 'https://live.wostreaming.net/direct/ppm-jazz24aac-ibc1', tags: 'jazz,smooth jazz', country: 'The United States Of America' },
    ],
    books: [
      { id: 'demo-book-thursday-murder', title: 'The Thursday Murder Club', author: 'Richard Osman', isbn: '9781984880963', publishedYear: 2020, progress: 0.18 },
    ],
    bookmarks: [
      { url: 'https://www.mayoclinic.org', title: 'Mayo Clinic', siteName: 'Mayo Clinic', category: 'Health' },
      { url: 'https://www.bbcgoodfood.com', title: 'BBC Good Food', siteName: 'BBC Good Food', category: 'Food' },
    ],
    personalFeeds: [
      { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', title: 'BBC World News', siteUrl: 'https://www.bbc.com/news' },
      { url: 'https://feeds.npr.org/1001/rss.xml', title: 'NPR News', siteUrl: 'https://www.npr.org' },
    ],
    chat: {
      title: 'Sourdough starter questions',
      turns: [
        { role: 'user', content: 'My sourdough starter looks flat this morning. Did I ruin it?' },
        { role: 'assistant', content: 'Not at all — a flat starter usually just means it’s hungry. Discard half and feed it equal parts flour and lukewarm water, then leave it somewhere warm. It should be bubbly again within 4–6 hours. Kitchens run cool this time of year, so the top of the fridge works nicely.' },
        { role: 'user', content: 'Wonderful, thank you dear. I’ll feed it after breakfast.' },
        { role: 'assistant', content: 'Perfect. If it doubles in size and smells pleasantly tangy, it’s ready to bake with. Happy baking, Rose!' },
      ],
    },
    memory: { text: 'Bakes sourdough bread weekly and enjoys classic films and jazz.', category: 'preference', tier: 'durable' },
    notifications: [{ message: 'Reminder: water the garden this evening', priority: 'normal' }],
  },
]
