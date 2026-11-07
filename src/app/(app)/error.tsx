"use client";
import Link from "next/link";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const denied = /not allowed|permission/i.test(error.message);
  return (
    <div className="card mx-auto mt-10 max-w-md p-6 text-center">
      <h1 className="text-lg font-semibold">{denied ? "You don't have access to this" : "Something went wrong"}</h1>
      <p className="mt-1 text-sm text-slate-500">{denied ? "Ask Wisam or Chief if you need it." : "Please try again. If it keeps happening, tell Wisam."}</p>
      <div className="mt-4 flex justify-center gap-2"><button onClick={reset} className="btn">Try again</button><Link href="/" className="btn btn-primary">Dashboard</Link></div>
    </div>
  );
}
