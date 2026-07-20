import { analyseProvenance } from "@study/core";
import type { TopicListItem } from "@/components/topic-page/topic-list";
import { parseStoredPage } from "@/lib/topics/topic-view";

/**
 * Turning the course page's topic rows into list items.
 *
 * Pure, and separate from the component for the same reason `topic-view.ts` is: the "does
 * this topic look weak from the outside?" judgement needs a test against the frozen Wave 4
 * artifact, and a component that fetched could not have one.
 *
 * `distinctLocators` is computed with **no documents supplied**, which makes every citation
 * `unknown-document` and therefore unresolved. That is deliberate: the list must not issue
 * a query per topic, and counting distinct `(documentId, page)` pairs from the page's own
 * blocks needs no document rows at all. The cost is that the list cannot tell a citation
 * pointing at an unread page from a good one — that distinction is the topic page's job,
 * one click away. So this counts raw distinct locators rather than resolved ones.
 */
export interface TopicListRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly exam_weight: number;
  readonly exam_weight_override: number | null;
  readonly page: unknown;
}

export function toTopicListItem(row: TopicListRow, needsReview: boolean): TopicListItem {
  const page = parseStoredPage(row.page);
  const report = analyseProvenance({ page, documents: [] });

  // Raw distinct locators, not resolved ones — see the module note.
  const locators = new Set(
    report.blocks.flatMap((block) =>
      block.citations.map((c) => `${c.documentId ?? "?"}#${c.page ?? "?"}`),
    ),
  );

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    examWeight: row.exam_weight_override ?? row.exam_weight,
    needsReview,
    distinctLocators: locators.size,
    blockCount: report.blocks.length,
  };
}
