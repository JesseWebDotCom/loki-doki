import type { Tool, ToolResult } from './index'
import { db } from '@/db'
import { homeDevices, homeServiceLog, homeDeviceLinks, homeDeviceFiles } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'

interface HomeArgs {
  query?: string
  deviceId?: string
  question?: string
}

async function execute(args: unknown): Promise<ToolResult> {
  const { query, deviceId, question } = (args ?? {}) as HomeArgs

  if (deviceId) {
    const device = await db.select().from(homeDevices).where(eq(homeDevices.id, deviceId)).then(r => r[0])
    if (!device) return { success: false, error: 'Device not found in home inventory.' }

    const [serviceEntries, links, files] = await Promise.all([
      db.select().from(homeServiceLog)
        .where(eq(homeServiceLog.deviceId, deviceId))
        .orderBy(desc(homeServiceLog.date)),
      db.select().from(homeDeviceLinks)
        .where(eq(homeDeviceLinks.deviceId, deviceId)),
      db.select().from(homeDeviceFiles)
        .where(eq(homeDeviceFiles.deviceId, deviceId))
        .orderBy(desc(homeDeviceFiles.createdAt)),
    ])

    // Parse specs JSON (stored as '{"key": "value"}')
    let parsedSpecs: Record<string, string> | null = null
    if (device.specs) {
      try { parsedSpecs = JSON.parse(device.specs) } catch { /* ignore */ }
    }

    // Manual: extract relevant section if question provided, otherwise full text (up to 4k)
    let manualContext: string | null = null
    if (device.manualText) {
      manualContext = question
        ? extractRelevantManualSection(device.manualText, question)
        : device.manualText.slice(0, 4_000)
    }

    // PDFs stored as files — include their names so AI knows what docs are available
    const pdfFiles = files.filter(f => f.fileType === 'pdf').map(f => ({
      label: f.label,
      comment: f.comment,
    }))

    return {
      success: true,
      data: {
        device: {
          name: device.name,
          brand: device.brand,
          model: device.model,
          serialNumber: device.serialNumber,
          category: device.category,
          location: device.location,
          owner: device.owner,
          description: device.description,
          manufacturedDate: device.manufacturedDate,
          specs: parsedSpecs,
          purchaseDate: device.purchaseDate,
          purchasePrice: device.purchasePrice,
          purchaseStore: device.purchaseStore,
          warrantyExpires: device.warrantyExpires,
          warrantyNotes: device.warrantyNotes,
          supportUrl: device.supportUrl,
          supportPhone: device.supportPhone,
          manualUrl: device.manualUrl,
          notes: device.notes,
        },
        links: links.map(l => ({ category: l.category, label: l.label, url: l.url })),
        attachedDocs: pdfFiles,
        serviceHistory: serviceEntries.map(e => ({
          date: e.date, type: e.type, description: e.description, technician: e.technician, cost: e.cost,
        })),
        manualContext,
      },
    }
  }

  const devices = await db.select().from(homeDevices)
  const lower = (query ?? '').toLowerCase()
  const matches = lower
    ? devices.filter(d =>
        d.name.toLowerCase().includes(lower) ||
        d.brand?.toLowerCase().includes(lower) ||
        d.model?.toLowerCase().includes(lower) ||
        d.category.toLowerCase().includes(lower) ||
        d.location?.toLowerCase().includes(lower)
      )
    : devices

  if (matches.length === 0) {
    return {
      success: true,
      data: { devices: [], message: lower ? `No devices found matching "${query}".` : 'No devices in home inventory yet.' },
    }
  }

  const today = new Date().toISOString().split('T')[0]
  return {
    success: true,
    data: {
      devices: matches.slice(0, 10).map(d => ({
        id: d.id,
        name: d.name,
        brand: d.brand,
        model: d.model,
        category: d.category,
        location: d.location,
        warrantyExpires: d.warrantyExpires,
        warrantyStatus: d.warrantyExpires
          ? d.warrantyExpires < today ? 'expired' : 'active'
          : 'unknown',
      })),
    },
  }
}

function extractRelevantManualSection(manualText: string, question: string): string {
  const keywords = question.toLowerCase().split(/\W+/).filter(w => w.length > 3)
  const paragraphs = manualText.split(/\n{2,}/)
  const scored = paragraphs.map(p => {
    const lower = p.toLowerCase()
    const score = keywords.reduce((s, kw) => s + (lower.includes(kw) ? 1 : 0), 0)
    return { p, score }
  })
  const top = scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(x => x.p)
  return top.join('\n\n').slice(0, 4_000)
}

export const homeInventoryTool: Tool = {
  id: 'home_inventory',
  name: 'Home Inventory',
  description: 'Search your home inventory for devices, appliances, and equipment. When looking up a specific device, always use its deviceId to get full details including specs, description, manufactured date, service history, support links, manual content, and attached documents.',
  examples: [
    "what appliances do I have?",
    "is my fridge still under warranty?",
    "what's the error code E5 on my dishwasher?",
    "when was my HVAC last serviced?",
    "find the support number for my printer",
    "what devices are in the kitchen?",
    "show me my home inventory",
    "my washing machine is showing an error",
    "how do I reset my router?",
    "what year did I buy the TV?",
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'home_inventory',
      description: 'Search the home inventory or look up full details for a specific device. Device details include: brand, model, serial number, description, specs (label key-values), manufactured date, purchase info, warranty, support contacts, support/manual/video links, full service history, attached document names, and extracted manual text relevant to the question.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search term to find devices (e.g. "fridge", "kitchen appliances", "Samsung")',
          },
          deviceId: {
            type: 'string',
            description: 'Specific device ID to get full details for',
          },
          question: {
            type: 'string',
            description: 'A specific question about the device to look up in the manual',
          },
        },
      },
    },
  },
  offline: true,
  dataSources: [],
  execute,
}
