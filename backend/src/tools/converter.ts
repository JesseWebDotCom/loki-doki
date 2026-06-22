import type { Tool, ToolResult } from './index'
import { capabilities } from '@/lib/converter/manager'
import { familyOf } from '@/lib/converter/formats'

// File conversion is inherently file-driven, but the chat pipeline only passes text to
// tools (no file/attachment is injected into tool config). So this tool can't run a
// conversion on an attached file — instead it answers "what can you convert?" / "convert
// X to Y" by reporting real capabilities and directing the user to the Converter app,
// which has the drag-and-drop upload. Honest and useful without fabricating a job.

export const converterTool: Tool = {
  id: 'file_converter',
  name: 'File Converter',
  description: 'Convert files between formats (images, audio, video) — e.g. PNG to JPG, WAV to MP3, MOV to MP4',
  offline: true,
  dataSources: [],
  passMessage: 'request',

  examples: [
    'convert this png to jpg',
    'how do I convert a heic to jpg',
    'can you change a wav file to mp3',
    'convert my mov video to mp4',
    'turn this image into a webp',
    'what file formats can you convert',
    'convert a tiff to png',
  ],

  toolDefinition: {
    type: 'function',
    function: {
      name: 'file_converter',
      description: 'Answer questions about converting files between formats and point the user to the Converter app. Use when the user asks to convert/change a file from one format to another (images, audio, video).',
      parameters: {
        type: 'object',
        required: ['request'],
        properties: {
          request: {
            type: 'string',
            description: "The user's full conversion request, e.g. 'convert this png to jpg'.",
          },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { request } = args as { request?: string }
    const caps = await capabilities()

    // Pull any "X to Y" / "to Y" format hints out of the message to tailor the reply.
    const text = (request ?? '').toLowerCase()
    const known = new Set<string>([
      ...caps.families.image.inputs, ...caps.families.image.outputs,
      ...caps.families.audio.inputs, ...caps.families.video.outputs,
      ...caps.families.video.inputs,
    ])
    const mentioned = Array.from(text.matchAll(/[a-z0-9]{2,4}/g))
      .map((m) => m[0])
      .filter((w) => known.has(w))
    const to = /\bto\s+([a-z0-9]{2,4})\b/.exec(text)?.[1]

    let answer: string
    const target = to && known.has(to) ? to : mentioned[mentioned.length - 1]
    const fam = target ? familyOf(target) : null
    if (fam) {
      const outs = caps.families[fam].outputs.join(', ')
      answer = `Yes — I can convert ${fam} files. Open the Converter app, drag your file in, and pick the output format (${fam} options: ${outs}). Conversions run locally on this device.`
    } else {
      answer = `I can convert images (${caps.families.image.outputs.join(', ')}), audio (${caps.families.audio.outputs.join(', ')}), and video (${caps.families.video.outputs.join(', ')}). Open the Converter app, drag your file in, and choose the output format.`
    }

    return {
      success: true,
      directReply: answer,
      data: { route: '/converter', vipsAvailable: caps.vipsAvailable, families: caps.families },
    }
  },
}
