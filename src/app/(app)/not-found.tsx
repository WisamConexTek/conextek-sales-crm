import Link from "next/link";
export default function NotFound() {
  return (
    <div className="card mx-auto mt-10 max-w-md p-6 text-center">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="mt-1 text-sm text-slate-500">This record doesn't exist, or it isn't assigned to you.</p>
      <Link href="/leads" className="btn btn-primary mt-4">Back to leads</Link>
    </div>
  );
}
