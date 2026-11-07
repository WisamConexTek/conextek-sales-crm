"use client";
import Link from "next/link";
import { useState } from "react";

/** A record reference the team can quote: "Task #12" (same number the API uses) + a copy-link button. */
export function Ref({ kind, id, href }: { kind: "Task" | "Approval"; id: number; href: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      navigator.clipboard?.writeText(`${window.location.origin}${href}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <Link href={href} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-slate-700 no-underline hover:bg-slate-200 hover:no-underline" title={`Open ${kind.toLowerCase()} ${id}`}>{kind} #{id}</Link>
      <button type="button" onClick={copy} className="rounded px-1 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100" title="Copy a direct link to this record">{copied ? "Copied ✓" : "Copy link"}</button>
    </span>
  );
}
