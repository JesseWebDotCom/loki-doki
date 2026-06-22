import { Hono } from 'hono'
import { db } from '@/db'
import { zimArchives } from '@/db/schema'
import { ZIM_CATALOG } from '@/lib/zimCatalog'
import { jokesTool } from '@/tools/jokes'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const bored = new Hono<AppEnv>()

export type ActivityCategory = 'article' | 'recipe' | 'joke' | 'idea' | 'create'

export interface Activity {
  id: string
  category: ActivityCategory
  title: string
  description: string
  icon: string
  href?: string     // internal route (react-router)
  prompt?: string   // auto-submit this prompt when navigating to /chat
  url?: string      // external link
  image?: string    // thumbnail (recipes, etc.)
  zimIconUrl?: string   // archive ZIM favicon — same value as /api/archives/installed
  zimCategory?: string  // archive ZIM category — for ArchiveIcon fallback
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = a[i]!
    a[i] = a[j]!
    a[j] = tmp
  }
  return a
}

function pick<T>(arr: T[], n: number): T[] {
  return shuffle(arr).slice(0, n)
}

// Always-available, offline-safe activity ideas. Some deep-link into the app.
const IDEA_POOL: Omit<Activity, 'id'>[] = [
  { category: 'create', icon: '🎨', title: 'Generate an image', description: 'Dream up a scene and let the AI paint it for you.', href: '/imaging' },
  { category: 'create', icon: '🎬', title: 'Make a short video', description: 'Animate a prompt or a photo into a moving clip.', href: '/video' },
  { category: 'idea',   icon: '🗺️', title: 'Explore the map', description: 'Wander somewhere new on the offline map.', href: '/maps' },
  { category: 'idea',   icon: '⛅', title: 'Check the sky', description: "See what the weather's up to today.", href: '/weather' },
  { category: 'idea',   icon: '💬', title: 'Start a conversation', description: "Ask your companion something surprising — it'll tell you something most people don't know.", href: '/chat', prompt: "Tell me something fascinating that most people don't know" },
  { category: 'idea',   icon: '🧠', title: 'Learn one new thing', description: 'Pick a random article and read for five minutes.', href: '/categories' },
  { category: 'idea',   icon: '✍️', title: 'Write a tiny story', description: 'Let your companion spark one — story starters, characters, and plot twists on demand.', href: '/chat', prompt: 'Help me write a tiny story — give me a few creative opening lines to choose from' },
  { category: 'idea',   icon: '📞', title: 'Reach out to someone', description: "Text or call a person you haven't spoken to in a while." },
  { category: 'idea',   icon: '🚶', title: 'Take a 10-minute walk', description: 'Step outside, no phone, just notice things.' },
  { category: 'idea',   icon: '🧹', title: 'Reset one small space', description: 'Tidy a single drawer, shelf, or corner.' },
  { category: 'idea',   icon: '🧘', title: 'Box breathing', description: 'In 4, hold 4, out 4, hold 4. Repeat five times.' },
  { category: 'idea',   icon: '🎧', title: 'Rediscover an old album', description: 'Play a record you loved years ago, start to finish.' },
  { category: 'idea',   icon: '🍵', title: 'Make a proper drink', description: 'Brew a tea or coffee slowly and actually savor it.' },
  { category: 'idea',   icon: '📷', title: 'Find five photos', description: 'Hunt for an interesting shot in your own home.' },
  { category: 'idea',   icon: '🧩', title: 'Solve a quick puzzle', description: 'Get a riddle or logic puzzle from your companion and see if you can crack it.', href: '/chat', prompt: 'Give me a fun riddle or logic puzzle to solve' },
]

async function archiveActivities(): Promise<Activity[]> {
  try {
    const rows = await db.select().from(zimArchives)
    const enriched = rows.map((row) => {
      const source = ZIM_CATALOG.find((s) => s.sourceId === row.sourceId)
      return {
        sourceId: row.sourceId,
        label: source?.label ?? row.sourceId,
        description: source?.description ?? null,
        category: source?.category ?? 'Other',
        faviconUrl: source?.faviconUrl ?? null,
      }
    })
    return pick(enriched, 4).map((a) => ({
      id: `article-${a.sourceId}-${Date.now()}`,
      category: 'article' as const,
      title: `Dive into ${a.label}`,
      description: a.description ?? `Browse the offline ${a.category.toLowerCase()} library.`,
      icon: '📚',
      href: `/read/${a.sourceId}`,
      zimIconUrl: `/api/archives/favicon/${a.sourceId}`,
      zimCategory: a.category,
    }))
  } catch {
    return []
  }
}

async function recipeActivity(): Promise<Activity | null> {
  try {
    const res = await fetch('https://www.themealdb.com/api/json/v1/1/random.php', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { meals: Array<Record<string, unknown>> | null }
    const meal = json.meals?.[0]
    if (!meal) return null
    const name = String(meal.strMeal ?? '')
    if (!name) return null
    const area = String(meal.strArea ?? '')
    const cat = String(meal.strCategory ?? '')
    const descr = [area, cat].filter(Boolean).join(' · ') || 'A dish to try tonight.'
    const url = String(meal.strSource ?? '') || String(meal.strYoutube ?? '') || undefined
    return {
      id: `recipe-${String(meal.idMeal ?? name)}`,
      category: 'recipe',
      title: `Cook: ${name}`,
      description: descr,
      icon: '🍳',
      url,
      image: String(meal.strMealThumb ?? '') || undefined,
    }
  } catch {
    return null
  }
}

async function jokeActivity(): Promise<Activity | null> {
  try {
    const result = await jokesTool.execute(null)
    if (!result.success) return null
    const joke = (result.data as { joke?: string })?.joke
    if (!joke) return null
    return {
      id: `joke-${Date.now()}`,
      category: 'joke',
      title: "Here's a joke",
      description: joke,
      icon: '😄',
    }
  } catch {
    return null
  }
}

// GET /api/bored/suggestions — a fresh, shuffled mix of things to do.
bored.get('/suggestions', requireAuth, async (c) => {
  const [archives, recipe, joke] = await Promise.all([
    archiveActivities(),
    recipeActivity(),
    jokeActivity(),
  ])

  const ideas: Activity[] = pick(IDEA_POOL, 5).map((idea, i) => ({ ...idea, id: `idea-${i}-${idea.title}` }))

  const activities = shuffle([
    ...archives,
    ...(recipe ? [recipe] : []),
    ...(joke ? [joke] : []),
    ...ideas,
  ]).slice(0, 9)

  return c.json({ activities })
})

export { bored }
