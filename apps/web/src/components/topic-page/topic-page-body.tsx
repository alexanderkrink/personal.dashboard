import { Function as FunctionIcon, Question, Textbox } from "@phosphor-icons/react/dist/ssr";
import type { ProvenanceBlock } from "@study/core";
import {
  CoverageMap,
  FidelityNotes,
  GroundingBanners,
} from "@/components/topic-page/grounding-banner";
import { Markdown } from "@/components/topic-page/markdown";
import { BlockProvenance, ProvenanceBlockShell } from "@/components/topic-page/provenance";
import type { TopicView } from "@/lib/topics/topic-view";

/**
 * The rendered topic page — PLAN's *"this is where 'reads like a book' is won"*.
 *
 * ## It is synchronous and takes only props, on purpose
 *
 * The route above it does the fetching. This component does the rendering, and because it
 * never awaits anything it can be handed a `TopicView` built from the frozen Wave 4 corpus
 * and asserted against in jsdom. That is not a testing convenience — it is the only way the
 * grounding affordances can have tests that are *red against the artifact they exist to
 * catch*. An affordance whose only test is a green one against a fixture somebody wrote to
 * make it pass is decoration.
 *
 * ## The register
 *
 * `.reading` (item 13b, built in Wave 1, first consumed here) is applied by the route, not
 * by this component, so this stays composable inside a drawer or a diff view that has
 * already established the register. Measure is 68ch per PLAN's per-surface note; mono
 * survives inside it for chips, locators and formulas, which is what makes the two
 * registers interlock rather than clash.
 */
export function TopicPageBody({ view }: { view: TopicView }) {
  const blocks = new Map(view.provenance.blocks.map((b) => [b.key, b]));
  const pageTitles = new Map(view.documents.map((d) => [d.id, d.pageTitles]));
  const { page } = view;

  return (
    <article className="space-y-8">
      <GroundingBanners view={view} />

      {page.summary.trim() === "" ? null : (
        <p className="text-read-body italic" data-testid="topic-summary">
          {page.summary}
        </p>
      )}

      {page.notes.length > 0 ? (
        <div className="space-y-6" data-testid="notes">
          {page.notes.map((note) => (
            <ProvenanceBlockShell block={blocks.get(`note:${note.id}`)} key={note.id}>
              <h3 className="mb-1 font-semibold text-read-h3">{note.heading}</h3>
              <div className="text-read-body">
                <Markdown>{note.markdown}</Markdown>
              </div>
              <Footer block={blocks.get(`note:${note.id}`)} pageTitles={pageTitles} />
            </ProvenanceBlockShell>
          ))}
        </div>
      ) : null}

      <Section
        icon={<FunctionIcon aria-hidden className="size-4" />}
        items={page.formulas}
        title="Formulas"
      >
        {(formula, index) => {
          const block = findBlock(blocks, "formula", index);
          const latex = formula.latex.trim();
          return (
            <ProvenanceBlockShell block={block} key={`${formula.name}:${formula.latex}`}>
              <p className="font-semibold text-read-body">{formula.name}</p>
              {/*
               * The formula is typeset through the same remark-math + KaTeX chain as the
               * inline math in prose (see `markdown.tsx`): wrapping the LaTeX in `$$…$$`
               * selects DISPLAY math. Empty/whitespace latex renders nothing rather than an
               * empty `$$$$` — the stored schema permits an empty string.
               */}
              {latex === "" ? null : (
                <div className="my-2 overflow-x-auto text-read-body">
                  <Markdown>{`$$${latex}$$`}</Markdown>
                </div>
              )}
              <div className="text-read-body">
                <Markdown>{formula.explanation}</Markdown>
              </div>
              <Footer block={block} pageTitles={pageTitles} />
            </ProvenanceBlockShell>
          );
        }}
      </Section>

      <Section
        icon={<Textbox aria-hidden className="size-4" />}
        items={page.keyTerms}
        title="Key terms"
      >
        {(term, index) => {
          const block = findBlock(blocks, "keyTerm", index);
          return (
            <ProvenanceBlockShell block={block} key={term.term}>
              <p className="font-semibold text-read-body">{term.term}</p>
              <div className="text-read-body">
                <Markdown>{term.definition}</Markdown>
              </div>
              <Footer block={block} pageTitles={pageTitles} />
            </ProvenanceBlockShell>
          );
        }}
      </Section>

      <Section items={page.workedExamples} title="Worked examples">
        {(example, index) => {
          const block = findBlock(blocks, "workedExample", index);
          return (
            <ProvenanceBlockShell block={block} key={example.problem}>
              <div className="text-read-body">
                <Markdown>{example.problem}</Markdown>
              </div>
              <div className="mt-2 border-border border-l-2 pl-3 text-read-body">
                <Markdown>{example.solution}</Markdown>
              </div>
              <Footer block={block} pageTitles={pageTitles} />
            </ProvenanceBlockShell>
          );
        }}
      </Section>

      {page.openQuestions.length > 0 ? (
        <section className="space-y-3" data-testid="open-questions">
          <h2 className="flex items-center gap-2 font-semibold text-read-h2">
            <Question aria-hidden className="size-4" />
            Open questions
          </h2>
          {page.openQuestions.map((question) => (
            <div
              className="rounded-md border border-warning/40 bg-warning/8 p-3"
              key={`${question.kind}:${question.question}`}
            >
              <p className="font-semibold text-read-body text-warning">{question.question}</p>
              <p className="mt-1 text-read-cap">{question.context}</p>
              <span className="mt-1 inline-block font-mono text-muted-foreground text-ui-xs">
                {question.kind}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      <section className="space-y-3 border-border border-t pt-6 font-sans">
        <h2 className="font-semibold text-muted-foreground text-ui-lg">Where this came from</h2>
        <CoverageMap view={view} />
        <FidelityNotes view={view} />
      </section>
    </article>
  );
}

function Footer({
  block,
  pageTitles,
}: {
  block: ProvenanceBlock | undefined;
  pageTitles: ReadonlyMap<string, ReadonlyMap<number, string>>;
}) {
  if (block === undefined) return null;
  return <BlockProvenance block={block} pageTitles={pageTitles} />;
}

function Section<T>({
  title,
  items,
  icon,
  children,
}: {
  title: string;
  items: readonly T[];
  icon?: React.ReactNode;
  children: (item: T, index: number) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-4" data-testid={title.toLowerCase().replace(/\s+/g, "-")}>
      <h2 className="flex items-center gap-2 font-semibold text-read-h2">
        {icon}
        {title}
      </h2>
      {items.map((item, index) => children(item, index))}
    </section>
  );
}

/**
 * Finds a rendered item's analysed block: the nth block of that family.
 *
 * Position within a family is **exact**, not a heuristic. `flattenTopicPage` walks
 * `page.keyTerms`, `page.formulas` and `page.workedExamples` in array order and this
 * component renders the same arrays in the same order, so the nth formula here is the nth
 * formula there. Matching on the label instead would be the fragile choice — two formulas
 * may legitimately share a name, and a page whose blocks are keyed by content would
 * mis-attribute provenance the moment they do.
 *
 * `undefined` is a real answer for an out-of-range index rather than an error, and
 * {@link ProvenanceBlockShell} renders it as `absent` — the honest reading of "this block
 * has no provenance record".
 */
function findBlock(
  blocks: ReadonlyMap<string, ProvenanceBlock>,
  kind: "formula" | "keyTerm" | "workedExample",
  index: number,
): ProvenanceBlock | undefined {
  return [...blocks.values()].filter((b) => b.kind === kind)[index];
}
