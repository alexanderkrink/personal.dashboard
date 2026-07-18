/**
 * The one page heading treatment for cockpit surfaces: `ui-xl` title, optional
 * terse `ui-md` lead. Kept separate from the top bar's context title so the
 * page can say more than the nav label does.
 */
export function PageHeader({
  title,
  lead,
  action,
}: {
  title: string;
  lead?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h2 className="font-semibold text-foreground text-ui-xl">{title}</h2>
        {lead ? <p className="max-w-prose text-muted-foreground text-ui-md">{lead}</p> : null}
      </div>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </div>
  );
}
