import { seedWakewordsFromManifest } from '@/lib/pod/companionWake'
const n = await seedWakewordsFromManifest()
console.log('seeded count:', n)
process.exit(0)
