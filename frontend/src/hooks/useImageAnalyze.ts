import { useCallback, useState } from 'react'

export type AnalysisTask = 'description' | 'scene' | 'objects' | 'text' | 'vehicles' | 'language'

export interface DetectedObject {
  label: string
  confidence: number
  area?: string // rough screen region: e.g. "top-left", "center", "bottom-right"
}

export interface DetectedText {
  value: string
  language: string
  type: 'license_plate' | 'sign' | 'document' | 'other'
  area?: string
}

export interface DetectedVehicle {
  type: string
  brand: string | null
  model: string | null
  plate: string | null
  plateState: string | null
  color: string | null
  area?: string
}

export interface AnalysisInference {
  timeOfDay: string | null
  country: string | null
  sourceType: string | null
  sourceBrand: string | null
  weather: string | null
  summary: string
}

export interface SafetyFlag {
  hazard: string
  context: string
  assessment: 'normal' | 'concerning' | 'critical'
  reason: string
  area?: string
}

export interface AnalysisResult {
  description: string
  scene: string
  inference: AnalysisInference
  safety: SafetyFlag[]
  objects: DetectedObject[]
  text: DetectedText[]
  vehicles: DetectedVehicle[]
}

export interface AnalysisHistoryItem {
  id: string
  model: string
  tasks: AnalysisTask[]
  result: AnalysisResult | null
  createdAt: string | number
}

export type AnalysisStatus = 'idle' | 'running' | 'done' | 'error'

export function useImageAnalyze() {
  const [status, setStatus] = useState<AnalysisStatus>('idle')
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [resultId, setResultId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const analyze = useCallback(async (file: File, tasks: AnalysisTask[]): Promise<AnalysisResult | null> => {
    setStatus('running')
    setResult(null)
    setError(null)
    setResultId(null)

    try {
      const form = new FormData()
      form.append('image', file)
      form.append('tasks', JSON.stringify(tasks))

      const res = await fetch('/api/vision/analyze', {
        method: 'POST',
        credentials: 'include',
        body: form,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }

      const data = await res.json() as { id: string; result: AnalysisResult; state: string }
      setResult(data.result)
      setResultId(data.id)
      setStatus('done')
      return data.result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setStatus('error')
      return null
    }
  }, [])

  const reset = useCallback(() => {
    setStatus('idle')
    setResult(null)
    setResultId(null)
    setError(null)
  }, [])

  return { status, result, resultId, error, analyze, reset }
}
