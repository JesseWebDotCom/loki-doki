import { describe, expect, it } from "vitest";

import { describeRelationshipForPerson } from "../relationshipLabels";

describe("describeRelationshipForPerson", () => {
  it("shows a parent edge as parent from the child's perspective", () => {
    const label = describeRelationshipForPerson(
      {
        id: 1,
        from_person_id: 10,
        from_person_name: "Luke",
        to_person_id: 20,
        to_person_name: "Leia",
        edge_type: "parent",
        confidence: 1,
      },
      20,
    );
    expect(label).toBe("parent");
  });

  it("shows a child edge as parent from the child's perspective", () => {
    const label = describeRelationshipForPerson(
      {
        id: 2,
        from_person_id: 20,
        from_person_name: "Leia",
        to_person_id: 10,
        to_person_name: "Luke",
        edge_type: "child",
        confidence: 1,
      },
      20,
    );
    expect(label).toBe("parent");
  });

  it("shows a parent edge as child from the parent's perspective", () => {
    const label = describeRelationshipForPerson(
      {
        id: 3,
        from_person_id: 10,
        from_person_name: "Luke",
        to_person_id: 20,
        to_person_name: "Leia",
        edge_type: "parent",
        confidence: 1,
      },
      10,
    );
    expect(label).toBe("child");
  });
});
