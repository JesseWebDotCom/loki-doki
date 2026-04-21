import React from "react";

import type { Block } from "../../../lib/response-types";
import { Skeleton } from "../../ui/skeleton";
import BlockShell from "./BlockShell";

/**
 * Steps block renderer (chunk 14).
 *
 * Numbered ordered list. Each item carries ``{n, text, substeps?}``.
 * The renderer stays visually light — no heavy card borders per step
 * (per chunk-14 spec). Substeps, when present, are an unstyled inner
 * list under the parent step.
 *
 * ``block.items`` shape:
 *   ``[{ n: number, text: string, substeps?: string[] }]``
 */
interface StepItem {
  n?: number;
  text?: string;
  substeps?: string[];
}

interface NormalizedStep {
  n: number;
  text: string;
  substeps?: string[];
}

const StepsBlock: React.FC<{ block: Block }> = ({ block }) => {
  const rawItems = (block.items as StepItem[] | undefined) ?? [];
  const items: NormalizedStep[] = [];
  rawItems.forEach((entry, index) => {
    const text = String(entry?.text ?? "").trim();
    if (!text) return;
    const substeps = Array.isArray(entry?.substeps)
      ? entry!
          .substeps!.map((s) => String(s ?? "").trim())
          .filter((s) => s.length > 0)
      : [];
    const step: NormalizedStep = {
      n: typeof entry?.n === "number" ? entry.n : index + 1,
      text,
    };
    if (substeps.length > 0) {
      step.substeps = substeps;
    }
    items.push(step);
  });

  return (
    <BlockShell
      block={block}
      skeleton={
        <div
          data-slot="steps-skeleton"
          className="my-4 space-y-3"
          aria-hidden="true"
        >
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex items-start gap-3">
              <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ))}
        </div>
      }
    >
      <ol
        data-slot="steps-block"
        data-step-count={items.length}
        className="my-4 space-y-3"
      >
        {items.map((step) => (
          <li
            key={step.n}
            data-slot="steps-item"
            className="flex items-start gap-3 leading-7 text-foreground/90"
          >
            <span
              className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-[11px] font-semibold text-primary"
              aria-hidden="true"
            >
              {step.n}
            </span>
            <div className="flex-1">
              <div>{step.text}</div>
              {step.substeps ? (
                <ul className="ml-5 mt-1 list-disc space-y-1 text-[0.9rem] leading-6 text-foreground/75">
                  {step.substeps.map((sub, index) => (
                    <li key={index}>{sub}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </BlockShell>
  );
};

export default StepsBlock;
