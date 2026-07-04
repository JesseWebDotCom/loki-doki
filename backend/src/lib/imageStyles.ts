// Intent-to-style detection for image generation.
// Maps the user's raw message into prompt prefix/negative-prompt pairs.
// Order of detection matters: most specific first.

export type ImageStyle =
  | 'photorealistic'
  | 'sketch'
  | 'watercolor'
  | 'oil_painting'
  | 'cartoon'
  | 'anime'
  | 'pixel_art'
  | '3d_render'
  | 'illustration'

interface StyleMod {
  label: string
  prefix: string
  negative: string
}

const MODS: Record<ImageStyle, StyleMod> = {
  sketch: {
    label: 'Pencil Sketch',
    prefix: 'pencil sketch, hand-drawn, detailed linework, graphite, monochrome, ',
    negative: 'photorealistic, photograph, colorful, digital painting, ',
  },
  watercolor: {
    label: 'Watercolor',
    prefix: 'watercolor painting, soft brushstrokes, flowing pigment, translucent, loose edges, ',
    negative: 'photorealistic, sharp edges, digital art, photograph, ',
  },
  oil_painting: {
    label: 'Oil Painting',
    prefix: 'oil painting on canvas, thick brushwork, textured, classical art, rich colors, ',
    negative: 'photorealistic, photograph, digital, flat, ',
  },
  cartoon: {
    label: 'Cartoon',
    prefix: 'cartoon style, bold outlines, cel-shaded, flat colors, vibrant, clean lines, ',
    negative: 'photorealistic, realistic, photograph, 3D render, ',
  },
  anime: {
    label: 'Anime',
    prefix: 'anime style, manga illustration, detailed, vibrant, clean linework, ',
    negative: 'photorealistic, western cartoon, realistic photograph, ',
  },
  pixel_art: {
    label: 'Pixel Art',
    prefix: 'pixel art, 8-bit style, retro game art, pixelated, low resolution, ',
    negative: 'photorealistic, smooth, high resolution, anti-aliased, ',
  },
  '3d_render': {
    label: '3D Render',
    prefix: '3D render, CGI, ray tracing, digital art, subsurface scattering, high detail, ',
    negative: 'flat, 2D, sketch, painted, watercolor, ',
  },
  illustration: {
    label: 'Illustration',
    prefix: 'digital illustration, vibrant colors, detailed artwork, professional, ',
    negative: 'photograph, photorealistic, blurry, ',
  },
  photorealistic: {
    label: 'Photo',
    prefix: 'photorealistic, RAW photo, highly detailed, sharp focus, 8k resolution, ',
    negative: 'cartoon, illustration, drawing, anime, painted, blurry, ',
  },
}

const STYLE_PATTERNS: Array<[ImageStyle, RegExp]> = [
  ['pixel_art',    /\b(pixel\s*art|8-?bit|retro\s*game\s*art|pixelat)\b/i],
  ['anime',        /\b(anime|manga|manhwa)\b/i],
  ['cartoon',      /\b(cartoon|animated|caricature|comic\s*strip|toon)\b/i],
  ['watercolor',   /\b(water\s*colou?r|gouache)\b/i],
  ['oil_painting', /\b(oil\s*paint(ing)?|acrylic\s*paint(ing)?|painted)\b/i],
  ['sketch',       /\b(sketch|draw(ing)?|pencil|hand[- ]?drawn|doodle|line\s*art|lineart|handcraft)\b/i],
  ['3d_render',    /\b(3[Dd]\s*(render|art|model)|cgi|octane|blender\s*render)\b/i],
  ['illustration', /\b(illustrat(e|ion|ed)|artwork)\b/i],
]

export function detectStyle(rawMessage: string): ImageStyle {
  for (const [style, pattern] of STYLE_PATTERNS) {
    if (pattern.test(rawMessage)) return style
  }
  return 'photorealistic'
}

export function applyStyleToPrompt(
  subject: string,
  style: ImageStyle,
  existingNegative?: string,
): { prompt: string; negativePrompt: string; styleLabel: string } {
  const mod = MODS[style]
  return {
    prompt: mod.prefix + subject,
    negativePrompt: mod.negative + (existingNegative ?? ''),
    styleLabel: mod.label,
  }
}

// Flat-art bias for SVG (vector) output. Naively tracing a detailed/photoreal render into
// vector paths yields thousands of mushy shapes and a huge file; steering generation toward
// flat, posterized, limited-palette art keeps the traced SVG clean and editable. This
// COMPOSES on top of any user-selected style/LoRA (prepended), rather than replacing it.
const VECTORIZE_PREFIX = 'flat vector illustration, bold clean shapes, limited color palette, high contrast, sharp edges, minimal fine detail, '
const VECTORIZE_NEGATIVE = 'photorealistic, gradient, film grain, noise, texture, fine detail, blurry, soft focus, '

export function applyVectorizeBias(
  prompt: string,
  negativePrompt?: string,
): { prompt: string; negativePrompt: string } {
  return {
    prompt: VECTORIZE_PREFIX + prompt,
    negativePrompt: VECTORIZE_NEGATIVE + (negativePrompt ?? ''),
  }
}
