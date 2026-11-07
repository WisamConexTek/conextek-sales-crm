import Image from "next/image";
import { redirect } from "next/navigation";
import { getSessionActor } from "@/lib/auth";
import { loginAction } from "@/app/actions";
import { Flash } from "@/components/ui";
import { first } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await getSessionActor()) redirect("/");
  const sp = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-600 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <Image src="/logo-light.png" alt="ConexTek" width={530} height={270} priority className="mx-auto h-auto w-56" />
          <p className="mt-1 text-sm uppercase tracking-widest text-white/80">Sales CRM</p>
        </div>
        <div className="card p-6">
          <Flash ok={first(sp.ok)} err={first(sp.err)} />
          <form action={loginAction} className="space-y-4">
            <div><label className="label" htmlFor="u">Username</label><input id="u" name="username" className="input" autoComplete="username" autoFocus required /></div>
            <div><label className="label" htmlFor="p">Password</label><input id="p" name="password" type="password" className="input" autoComplete="current-password" required /></div>
            <button className="btn btn-accent w-full">Sign in</button>
          </form>
          <p className="mt-4 text-center text-xs text-slate-500">Forgot your password? Ask Wisam or Chief to reset it from Settings.</p>
        </div>
      </div>
    </div>
  );
}
