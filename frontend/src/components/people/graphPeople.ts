import type { PeopleEdge, Person } from "../../lib/api-types";

export function buildGraphPeopleMap(people: Person[], edges: PeopleEdge[]): Map<number, Person> {
  const peopleMap = new Map<number, Person>();
  for (const person of people) {
    peopleMap.set(person.id, person);
  }
  for (const edge of edges) {
    if (!peopleMap.has(edge.from_person_id)) {
      peopleMap.set(edge.from_person_id, {
        id: edge.from_person_id,
        name: edge.from_person_name,
      });
    }
    if (!peopleMap.has(edge.to_person_id)) {
      peopleMap.set(edge.to_person_id, {
        id: edge.to_person_id,
        name: edge.to_person_name,
      });
    }
  }
  return peopleMap;
}
