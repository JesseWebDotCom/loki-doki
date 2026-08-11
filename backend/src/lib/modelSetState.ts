// Sync, dependency-free holder for the active model set. Kept separate from
// lib/modelSets.ts (the orchestrator) so hot-path readers like engineAutotune can
// import it without pulling in settings/db/downloadJobs and creating import cycles.
// Primed at boot by initModelSets(); updated when a set switch finalizes.
import { DEFAULT_MODEL_SET, type ModelSetId } from '@/lib/catalog'

let active: ModelSetId = DEFAULT_MODEL_SET

export function getActiveModelSetSync(): ModelSetId {
  return active
}

export function setActiveModelSetSync(set: ModelSetId): void {
  active = set
}
