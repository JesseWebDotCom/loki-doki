import type { Tool, ToolResult } from './index'

const API = 'https://www.themealdb.com/api/json/v1/1'

function ingredients(meal: Record<string, unknown>): string[] {
  const out: string[] = []
  for (let i = 1; i <= 20; i++) {
    const name = String(meal[`strIngredient${i}`] ?? '').trim()
    const measure = String(meal[`strMeasure${i}`] ?? '').trim()
    if (name) out.push(measure ? `${measure} ${name}` : name)
  }
  return out
}

function deriveAnswerPayload(data: {
  name: string; category: string; area: string; instructions: string; ingredients: string[]; source: string
}) {
  const { name, category, area, instructions, source } = data
  if (!name) return { gist: '', highlights: [], sources: [], depth_available: false }
  const descriptors = [area, category].filter(Boolean).join(', ')
  const head = descriptors ? `"${name}" (${descriptors})` : `"${name}"`
  const firstSentence = (instructions.split(/\.\s+/)[0] ?? '').trim()
  const gist = firstSentence ? `${head}: ${firstSentence}.` : head
  const highlights = data.ingredients.slice(0, 5).filter(Boolean)
  const sources = source ? [{ url: source, title: name }] : []
  return { gist, highlights, sources, depth_available: instructions.length > 400 }
}

export const recipesTool: Tool = {
  id: 'recipes',
  name: 'Recipes',
  description: 'Search recipes by name or keyword via TheMealDB',
  offline: false,
  dataSources: [
    { name: 'TheMealDB', domain: 'themealdb.com', purpose: 'Recipe search and meal information', type: 'api' },
  ],
  passMessage: 'query',
  examples: [
    'cooking recipe with ingredients and instructions for a dish',
    'how to make or cook a specific meal or food',
    'what to cook tonight or what to make with certain ingredients',
    'step-by-step cooking instructions for any recipe',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'recipes',
      description: 'Search for a recipe by dish name',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Dish or ingredient name, e.g. "chicken tikka masala"' },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { query } = args as { query: string }
    if (!query?.trim()) return { success: false, error: 'Query is required' }

    try {
      const res = await fetch(`${API}/search.php?s=${encodeURIComponent(query.trim())}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
      })
      if (!res.ok) return { success: false, error: `API error: ${res.status}` }

      const json = (await res.json()) as { meals: Record<string, unknown>[] | null }
      const meals = json.meals
      if (!meals?.length) return { success: true, data: { found: false, answer_payload: { gist: `No recipe found for "${query}".` } } }

      const meal = meals[0] as Record<string, unknown>
      const data = {
        name: String(meal.strMeal ?? ''),
        category: String(meal.strCategory ?? ''),
        area: String(meal.strArea ?? ''),
        instructions: String(meal.strInstructions ?? '').trim(),
        ingredients: ingredients(meal),
        thumbnail: String(meal.strMealThumb ?? ''),
        youtube: String(meal.strYoutube ?? ''),
        source: String(meal.strSource ?? ''),
        found: true,
      }
      return {
        success: true,
        data: { ...data, answer_payload: deriveAnswerPayload(data) },
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Network unavailable' }
      }
      return { success: false, error: String(err) }
    }
  },
}
