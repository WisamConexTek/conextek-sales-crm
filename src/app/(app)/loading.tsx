/** Shown instantly while a page's data loads, so moving between pages never looks frozen. */
export default function Loading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading">
      <div className="h-7 w-56 rounded bg-slate-200" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-20 rounded-lg bg-slate-100" />)}</div>
      <div className="h-64 rounded-lg bg-slate-100" />
      <div className="h-40 rounded-lg bg-slate-100" />
    </div>
  );
}
