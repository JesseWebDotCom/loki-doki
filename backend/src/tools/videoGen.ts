import type { Tool, ToolResult } from './index'
import { startImageJob, videoAvailable } from '@/routes/image'
import { comfyUrl } from '@/lib/comfyui'

export const videoGenTool: Tool = {
  id: 'video_gen',
  name: 'Video Generation',
  description: 'Generate a short animated video clip from a text description using AI',
  offline: false,
  dataSources: [],
  passMessage: 'prompt',

  examples: [
    'generate a video of a waterfall in a jungle',
    'create a short clip of a rocket launching into space',
    'make a video of waves crashing on a beach at sunset',
    'animate a butterfly landing on a flower',
    'create an animation of clouds drifting over mountains',
    'make a short video of a cat chasing a laser pointer',
    'generate a clip of rain falling on a city street at night',
    'show me a video of a campfire crackling in the woods',
    'animate a spaceship flying through an asteroid field',
    'create a moving shot of northern lights over a snowy field',
  ],

  toolDefinition: {
    type: 'function',
    function: {
      name: 'video_gen',
      description: 'Generate a short AI-animated video clip from a text description. Use when the user asks to create, generate, animate, or make a video, clip, animation, or moving image. For still pictures use image_gen instead.',
      parameters: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: {
            type: 'string',
            description: 'Vivid, detailed description of the scene and motion to animate. Include subject, action, style, lighting, and mood for best results.',
          },
          width: {
            type: 'number',
            description: 'Video width in pixels (256–2048). Default 1024.',
          },
          height: {
            type: 'number',
            description: 'Video height in pixels (256–2048). Default 576.',
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
      return { success: false, error: 'User context missing — cannot generate video' }
    }

    if (!videoAvailable()) {
      return {
        success: false,
        offline: true,
        error: 'Video generation is not set up. The AnimateDiff video model is not installed — add it in Admin → Features.',
      }
    }

    const rawMessage = config?.['_rawMessage'] as string | undefined

    const imageId = await startImageJob({
      userId,
      isAdmin: isAdmin ?? false,
      prompt: prompt.trim(),
      width:  width  ?? 1024,
      height: height ?? 576,
      pipeline: 'video',
      frames: 16,
      fps: 8,
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
          error: 'Video generation is offline. ComfyUI is not running — check Admin → Troubleshooting.',
        }
      }
      return {
        success: false,
        error: 'Video generation failed to start. Check Admin → Troubleshooting for details.',
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
