import type { Tool, ToolResult } from './index'
import { startImageJob } from '@/routes/image'
import { comfyUrl } from '@/lib/comfyui'

export const imageGenTool: Tool = {
  id: 'image_gen',
  name: 'Image Generation',
  description: 'Generate an image from a text description using AI',
  offline: false,
  dataSources: [],
  passMessage: 'prompt',

  examples: [
    'generate an image of a sunset over the ocean',
    'create a picture of a cat wearing a wizard hat',
    'draw a futuristic city at night',
    'make an image of a dog surfing a giant wave',
    'paint a watercolor of mountains in autumn',
    'create an illustration of a fairy in a magical forest',
    'generate a photo-realistic image of a lion on a savanna',
    'show me what a medieval castle looks like',
    'make a portrait of an astronaut on Mars',
    'create artwork of a hobo riding a barrel over a waterfall',
  ],

  toolDefinition: {
    type: 'function',
    function: {
      name: 'image_gen',
      description: 'Generate an AI image from a text description. Use when the user asks to create, generate, draw, paint, or show an image.',
      parameters: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: {
            type: 'string',
            description: 'Vivid, detailed description of what to generate. Include style, lighting, mood, and subject details for best results.',
          },
          width: {
            type: 'number',
            description: 'Image width in pixels (256–2048). Default 1024.',
          },
          height: {
            type: 'number',
            description: 'Image height in pixels (256–2048). Default 1024.',
          },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { prompt, width, height } = args as { prompt?: string; width?: number; height?: number }

    if (!prompt?.trim()) {
      return { success: false, error: 'No prompt provided' }
    }

    const userId  = config?.['_userId']  as string | undefined
    const isAdmin = config?.['_isAdmin'] as boolean | undefined

    if (!userId) {
      return { success: false, error: 'User context missing — cannot generate image' }
    }

    const rawMessage = config?.['_rawMessage'] as string | undefined

    const imageId = await startImageJob({
      userId,
      isAdmin: isAdmin ?? false,
      prompt: prompt.trim(),
      width:  width  ?? 1024,
      height: height ?? 1024,
      rawMessage,
    })

    if (!imageId) {
      let comfyReachable = false
      try {
        const r = await fetch(`${comfyUrl()}/system_stats`, { signal: AbortSignal.timeout(2_000) })
        comfyReachable = r.ok
      } catch { /* offline */ }

      if (!comfyReachable) {
        return {
          success: false,
          offline: true,
          error: 'Image generation is offline. ComfyUI is not running — check Admin → Troubleshooting.',
        }
      }
      return {
        success: false,
        error: 'Image generation failed to start. Check Admin → Troubleshooting for details.',
      }
    }

    return {
      success: true,
      data: {
        imageId,
        prompt: prompt.trim(),
        status: 'building',
      },
    }
  },
}
