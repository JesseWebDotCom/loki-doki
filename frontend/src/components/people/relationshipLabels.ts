import type { PeopleEdge } from "../../lib/api-types";

const PARENT_TERMS = new Set([
  "parent",
  "mother",
  "father",
  "mom",
  "dad",
  "mama",
  "papa",
  "step-mom",
  "step-dad",
  "stepmom",
  "stepdad",
]);

const CHILD_TERMS = new Set([
  "child",
  "son",
  "daughter",
  "kid",
]);

export function describeRelationshipForPerson(edge: PeopleEdge, personId: number): string {
  const edgeType = (edge.edge_type || "").trim();
  const normalized = edgeType.toLowerCase();
  if (edge.from_person_id === personId && (normalized === "child" || CHILD_TERMS.has(normalized))) {
    return "parent";
  }
  if (edge.to_person_id === personId && (normalized === "parent" || PARENT_TERMS.has(normalized))) {
    return "parent";
  }
  if (edge.from_person_id === personId && (normalized === "parent" || PARENT_TERMS.has(normalized))) {
    return "child";
  }
  if (edge.to_person_id === personId && (normalized === "child" || CHILD_TERMS.has(normalized))) {
    return "child";
  }
  return edgeType;
}
