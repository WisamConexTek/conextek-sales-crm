import { requireUser } from "@/lib/auth";
import { changePasswordAction } from "@/app/actions";
import { Card, Flash, PageHeader } from "@/components/ui";
import { first } from "@/lib/format";

export default async function Account({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireUser({ allowPasswordChange: true });
  const sp = await searchParams;
  return (
    <div className="max-w-lg">
      <PageHeader title="Account" sub={`${me.name} · ${me.username} · ${me.role}`} />
      {me.mustChangePassword && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">You are using a temporary password. Choose a new one to continue.</div>
      )}
      <Flash ok={first(sp.ok)} err={first(sp.err)} />
      <Card title="Change password">
        <form action={changePasswordAction} className="space-y-3">
          <div><label className="label">Current password</label><input name="current" type="password" className="input" autoComplete="current-password" required /></div>
          <div><label className="label">New password (10+ characters)</label><input name="next" type="password" className="input" autoComplete="new-password" minLength={10} required /></div>
          <div><label className="label">Repeat new password</label><input name="confirm" type="password" className="input" autoComplete="new-password" minLength={10} required /></div>
          <button className="btn btn-primary">Change password</button>
        </form>
      </Card>
    </div>
  );
}
