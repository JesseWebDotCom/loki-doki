// Fast logo generation route: LLM → SVG (instant) + SD quality path.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { generateLogoSvg } from '@/lib/logo/generate'
import type { AppEnv } from '@/types'
import type { LogoStyle } from '@/lib/logo/generate'

export const logoRoute = new Hono<AppEnv>()
logoRoute.use('*', requireAuth)

// Fast path: LLM → SVG in one shot
logoRoute.post('/generate', async (c) => {
  const body = await c.req.json<{
    name: string
    tagline?: string
    style?: LogoStyle
    primaryColor?: string
    accentColor?: string
  }>()

  if (!body.name?.trim()) return c.json({ error: 'name required' }, 400)

  try {
    const svg = await generateLogoSvg({
      name: body.name.trim(),
      tagline: body.tagline?.trim(),
      style: body.style ?? 'wordmark',
      primaryColor: body.primaryColor,
      accentColor: body.accentColor,
    })
    return c.json({ svg })
  } catch (err: any) {
    return c.json({ error: String(err?.message ?? err) }, 500)
  }
})

// Build a quality SD prompt for logo generation (used by the frontend to call /api/image/generate)
logoRoute.post('/quality-prompt', async (c) => {
  const body = await c.req.json<{
    name: string
    tagline?: string
    style?: LogoStyle
    primaryColor?: string
  }>()

  if (!body.name?.trim()) return c.json({ error: 'name required' }, 400)

  const stylePrompts: Record<string, string> = {
    wordmark:  'minimal wordmark logo, bold typography, clean geometric design',
    abstract:  'abstract geometric logo mark, modern shapes, vector art style',
    badge:     'circular badge emblem logo, seal design, professional branding',
    icon:      'simple icon logo mark, memorable symbol, minimal flat design',
    retro:     'retro vintage logo, classic typography, ornamental borders, nostalgic design',
  }

  const style = body.style ?? 'wordmark'
  const styleHint = stylePrompts[style] ?? stylePrompts['wordmark']!
  const prompt = `Professional ${styleHint} for "${body.name}"${body.tagline ? `, tagline "${body.tagline}"` : ''}, white background, high contrast, sharp edges, vector illustration, brand identity design, isolated logo, no background clutter`
  const negativePrompt = 'photo, realistic, 3d render, gradient background, busy background, watermark, text errors, blurry'

  return c.json({ prompt, negativePrompt })
})
