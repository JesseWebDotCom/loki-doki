import { BedDouble, Car, ChefHat, DoorOpen, Home, Monitor, TreePine, Tv2, UtensilsCrossed, Waves } from 'lucide-react'

// The room/area glyph, mapped from the area name. Shared so the Home Assistant
// page (grouped area headers) and the favorites widget (per-card room label)
// show the exact same icon for a given room.
export function AreaIcon({ name, className }: { name: string; className?: string }) {
  const n = name.toLowerCase()
  let Icon = Home
  if (/bed|master|sleep/.test(n)) Icon = BedDouble
  else if (/bath|shower/.test(n)) Icon = Waves
  else if (/kitchen|cook/.test(n)) Icon = ChefHat
  else if (/living|lounge|family|den/.test(n)) Icon = Tv2
  else if (/office|study|work/.test(n)) Icon = Monitor
  else if (/garage/.test(n)) Icon = Car
  else if (/garden|outdoor|yard|patio|deck|porch/.test(n)) Icon = TreePine
  else if (/hall|entry|entrance|foyer|corridor/.test(n)) Icon = DoorOpen
  else if (/dining|eat/.test(n)) Icon = UtensilsCrossed
  return <Icon className={className} />
}
