"use client";
import { useActionState, useState, type ReactNode } from "react";

export type SecretState = { secret?: string; message?: string; error?: string } | null;

/** A form whose server action returns a one-time secret (temp password / API key) shown in place — never stored in a URL. */
export function SecretAction({
  action, children, submit, className = "", secretLabel = "Copy this now — it will not be shown again",
}: {
  action: (prev: SecretState, fd: FormData) => Promise<SecretState>;
  children?: ReactNode; submit: string; className?: string; secretLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [copied, setCopied] = useState(false);
  return (
    <form action={formAction} className={className}>
      {children}
      <button className="btn btn-sm" disabled={pending}>{pending ? "Working…" : submit}</button>
      {state?.error && <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-sm text-red-800">{state.error}</p>}
      {state?.secret && (
        <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-900">{state.message} {secretLabel}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="break-all rounded bg-white px-2 py-1 text-sm select-all">{state.secret}</code>
            <button type="button" className="btn btn-sm" onClick={() => { navigator.clipboard?.writeText(state.secret!); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button>
          </div>
        </div>
      )}
    </form>
  );
}
