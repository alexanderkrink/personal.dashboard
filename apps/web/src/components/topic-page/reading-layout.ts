/**
 * The topic page's reading column, shared by its header, body and exam-weight slider.
 *
 * 68ch is the measure the reading register asks for — a full-width 18px serif is a ~200ch
 * line nobody can track back from, so the cap stays. What changed in Wave 7 is the
 * anchoring: `mx-auto` centred the column, stranding the whole page dead in the middle of a
 * wide monitor behind a lake of blank canvas. Dropping it lets the column hug the
 * content-start gutter the route sets with `p-4 sm:p-6`, with a subtle `xl:ml-8` inset so
 * an ultrawide viewport is not flush to the edge. A marginalia rail is the post-M1 answer;
 * do not reintroduce `mx-auto`/auto-centring to fake one.
 */
export const READING_COLUMN_CLASS = "max-w-[68ch] xl:ml-8";
