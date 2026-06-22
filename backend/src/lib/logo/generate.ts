// Fast logo generator: LLM → raw SVG in one pass.
// No new binary deps — the model outputs SVG markup directly.

import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'

export type LogoStyle = 'wordmark' | 'abstract' | 'badge' | 'icon' | 'retro'

export interface LogoOptions {
  name: string
  tagline?: string
  style: LogoStyle
  primaryColor?: string   // hex, e.g. "#6d28d9"
  accentColor?: string    // hex
  size?: number           // viewBox size, default 400
}

const STYLE_PROMPTS: Record<LogoStyle, string> = {
  wordmark: `Create a wordmark logo. The company/brand name is displayed prominently as stylized text.
Use a single bold sans-serif typeface. Add a simple geometric shape or line accent.
The text should be large and fill most of the square. No icons or complex illustrations.`,

  abstract: `Create an abstract geometric logo mark. Use 2-4 geometric shapes (circles, triangles, hexagons, or curves)
that overlap or interlock. The brand name appears below in clean sans-serif.
Focus on the geometric composition being visually interesting and balanced.`,

  badge: `Create a badge/emblem logo. A circle or shield border contains the brand name and a small icon or symbol.
Add a subtle banner or tagline inside if provided. Think: classic seal, sports emblem, circular badge.
Make it look sturdy and authoritative.`,

  icon: `Create a simple icon/symbol logo. Design an original icon that represents the brand concept —
a minimal but memorable symbol (like a leaf, lightning bolt, speech bubble, star, etc.).
The brand name appears below in clean sans-serif. The icon should work at small sizes.`,

  retro: `Create a retro/vintage style logo. Use bold lettering with slight imperfections or texture,
decorative borders, a muted or duotone color palette, and classic design elements like sunbursts,
laurels, or ribbons. Think 1920s-1960s poster art.`,
}

const SYSTEM_PROMPT = `You are a professional SVG logo designer. You produce clean, valid SVG markup.

Rules:
- Output ONLY the SVG element — no markdown fences, no explanations, no text before/after
- viewBox must be "0 0 400 400" (square)
- Use only inline SVG — no external resources, no <image> tags, no Google Fonts
- Use generic font families: "Arial, Helvetica, sans-serif" or "Georgia, serif" or "Courier New, monospace"
- All shapes and text must be SVG primitives: rect, circle, ellipse, path, polygon, text, tspan, g
- Colors must use hex (#rrggbb) — no named colors except "white" and "black"
- The SVG must be self-contained and render correctly without any external dependencies
- Keep it elegant and professional — avoid over-cluttering
- Text must be legible at small sizes`

export async function generateLogoSvg(opts: LogoOptions): Promise<string> {
  const { name, tagline, style, primaryColor = '#6d28d9', accentColor = '#a78bfa', size = 400 } = opts

  const styleGuide = STYLE_PROMPTS[style]
  const model = await getFastModel()

  const userPrompt = `Design a ${style} logo for: "${name}"
${tagline ? `Tagline: "${tagline}"` : ''}
Primary color: ${primaryColor}
Accent color: ${accentColor}
Canvas: ${size}×${size} viewBox

Style instructions:
${styleGuide}

Output a single complete SVG element.`

  const resp = await ollamaChat(model, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: userPrompt },
  ])

  const raw = resp.message?.content ?? ''

  // Extract just the SVG element
  const svgMatch = raw.match(/<svg[\s\S]*?<\/svg>/i)
  if (!svgMatch) {
    // Fallback: build a minimal text-only SVG
    return buildFallbackSvg(name, primaryColor, accentColor)
  }

  let svg = svgMatch[0]!

  // Ensure viewBox and xmlns are set
  if (!svg.includes('xmlns')) {
    svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
  }
  if (!svg.includes('viewBox')) {
    svg = svg.replace('<svg', `<svg viewBox="0 0 ${size} ${size}"`)
  }

  return svg
}

function buildFallbackSvg(name: string, primary: string, accent: string): string {
  const displayName = name.length > 14 ? name.slice(0, 14) + '…' : name
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <rect width="400" height="400" fill="${primary}" rx="32"/>
  <circle cx="200" cy="140" r="60" fill="${accent}" opacity="0.4"/>
  <circle cx="200" cy="140" r="36" fill="${accent}"/>
  <text x="200" y="245" font-family="Arial,Helvetica,sans-serif" font-size="52" font-weight="bold"
    fill="white" text-anchor="middle" dominant-baseline="middle">${escapeXml(displayName)}</text>
</svg>`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
