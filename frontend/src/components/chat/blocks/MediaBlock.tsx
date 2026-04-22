import React from "react";

import type { Block } from "../../../lib/response-types";
import type { MediaCard } from "../../../lib/api";
import MediaBar from "../MediaBar";
import BlockShell from "./BlockShell";

/**
 * Media block renderer.
 *
 * Wraps the existing ``MediaBar`` component — YouTube video cards,
 * YouTube channel cards, 3-card scroll layout, all behavior unchanged.
 * ``block.items`` is the same ``MediaCard[]`` discriminated union the
 * synthesis payload already carries.
 *
 * State chrome is delegated to ``BlockShell``. A short, media-shaped
 * skeleton is used in place of the default text skeleton so the
 * ``loading`` placeholder hints at the row layout instead of a prose
 * ladder.
 */
const MediaBlock: React.FC<{ block: Block }> = ({ block }) => {
  if (block.state !== "ready") {
    return null;
  }

  const items = (block.items as MediaCard[] | undefined) ?? [];

  return (
    <BlockShell block={block}>
      <MediaBar media={items} />
    </BlockShell>
  );
};

export default MediaBlock;
