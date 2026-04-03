import { Trash2, UserRoundPlus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { type RegisteredPerson } from "@/components/person-registration-utils"

export function RegisteredPeopleCard({
  people,
  onRemove,
}: {
  people: RegisteredPerson[]
  onRemove: (name: string) => void
}) {
  return (
    <Card className="border-[var(--line)] bg-[var(--card)] text-[var(--foreground)]">
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <UserRoundPlus className="h-4 w-4 text-[var(--accent)]" />
          <div className="text-sm font-semibold">Registered People</div>
        </div>
        <div className="space-y-2">
          {people.length === 0 ? (
            <div className="rounded-2xl border border-[var(--line)] bg-[var(--input)] p-4 text-sm text-[var(--muted-foreground)]">No one has been registered yet.</div>
          ) : people.map((person) => (
            <div key={person.name} className="flex items-center justify-between rounded-[24px] border border-[var(--line)] bg-[var(--input)] px-4 py-3">
              <div>
                <div className="text-sm text-[var(--foreground)]">{person.name}</div>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                  <span className={`rounded-full border px-2 py-1 ${person.modes.includes("close_up") ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-[var(--line)] bg-[var(--panel)] text-[var(--muted-foreground)]"}`}>close-up {person.modes.includes("close_up") ? "done" : "pending"}</span>
                  <span className={`rounded-full border px-2 py-1 ${person.modes.includes("far") ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-[var(--line)] bg-[var(--panel)] text-[var(--muted-foreground)]"}`}>far {person.modes.includes("far") ? "done" : "pending"}</span>
                  <span className={`rounded-full border px-2 py-1 ${person.is_complete ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-amber-500/40 bg-amber-500/10 text-amber-200"}`}>{person.is_complete ? "ready" : "incomplete"}</span>
                </div>
              </div>
              <Button className="h-9 rounded-full px-3 text-xs" onClick={() => onRemove(person.name)} type="button" variant="outline">
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Remove
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
