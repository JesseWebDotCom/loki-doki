import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const API = 'https://www.themealdb.com/api/json/v1/1'

interface MealRaw {
  idMeal?: unknown
  strMeal?: unknown
  strCategory?: unknown
  strArea?: unknown
  strMealThumb?: unknown
  strInstructions?: unknown
  strSource?: unknown
  strYoutube?: unknown
  [key: string]: unknown
}

interface Meal {
  id: string
  name: string
  category: string
  area: string
  image: string
  instructions: string
  ingredients: string[]
  source: string
  youtube: string
}

function buildIngredients(meal: MealRaw): string[] {
  const out: string[] = []
  for (let i = 1; i <= 20; i++) {
    const name = String(meal[`strIngredient${i}`] ?? '').trim()
    const measure = String(meal[`strMeasure${i}`] ?? '').trim()
    if (name) out.push(measure ? `${measure} ${name}` : name)
  }
  return out
}

function shapeMeal(meal: MealRaw, includeInstructions = true): Meal {
  return {
    id: String(meal.idMeal ?? ''),
    name: String(meal.strMeal ?? ''),
    category: String(meal.strCategory ?? ''),
    area: String(meal.strArea ?? ''),
    image: String(meal.strMealThumb ?? ''),
    instructions: includeInstructions ? String(meal.strInstructions ?? '').trim() : '',
    ingredients: buildIngredients(meal),
    source: String(meal.strSource ?? ''),
    youtube: String(meal.strYoutube ?? ''),
  }
}

const recipesRoute = new Hono<AppEnv>()

recipesRoute.get('/random', requireAuth, async (c) => {
  try {
    const res = await fetch(`${API}/random.php`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return c.json({ error: `Upstream error: ${res.status}` }, 502)
    const json = (await res.json()) as { meals: MealRaw[] | null }
    const meal = json.meals?.[0]
    if (!meal) return c.json({ error: 'No meal returned' }, 502)
    return c.json(shapeMeal(meal, true))
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return c.json({ error: 'Network timeout' }, 504)
    }
    return c.json({ error: String(err) }, 500)
  }
})

recipesRoute.get('/search', requireAuth, async (c) => {
  const q = c.req.query('q')?.trim() ?? ''
  if (!q) return c.json({ meals: [] })

  try {
    const res = await fetch(`${API}/search.php?s=${encodeURIComponent(q)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return c.json({ error: `Upstream error: ${res.status}` }, 502)
    const json = (await res.json()) as { meals: MealRaw[] | null }
    const meals = (json.meals ?? []).map((m) => shapeMeal(m, true))
    return c.json({ meals })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return c.json({ error: 'Network timeout' }, 504)
    }
    return c.json({ error: String(err) }, 500)
  }
})

export { recipesRoute }
