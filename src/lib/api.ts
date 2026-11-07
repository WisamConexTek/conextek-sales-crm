import { getApiActor, HttpError, type Actor } from "./auth";

type Ctx<P> = { actor: Actor; req: Request; params: P; url: URL; body: () => Promise<Record<string, unknown>> };

/** Wraps an API handler: bearer auth, JSON in/out, uniform errors. */
export function route<P = Record<string, never>>(fn: (c: Ctx<P>) => Promise<unknown>) {
  return async (req: Request, { params }: { params: Promise<P> }) => {
    try {
      const actor = await getApiActor(req);
      const body = async () => {
        const j = await req.json().catch(() => null);
        if (!j || typeof j !== "object" || Array.isArray(j)) throw new HttpError(400, "Send a JSON object body (Content-Type: application/json).");
        return j as Record<string, unknown>;
      };
      const data = await fn({ actor, req, params: await params, url: new URL(req.url), body });
      return Response.json({ ok: true, data });
    } catch (e) {
      if (e instanceof HttpError) {
        const dups = (e as HttpError & { duplicates?: unknown }).duplicates;
        return Response.json({ ok: false, error: e.message, ...(dups ? { duplicates: dups } : {}) }, { status: e.status });
      }
      console.error(e);
      return Response.json({ ok: false, error: "Server error." }, { status: 500 });
    }
  };
}
export const id = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "Invalid id.");
  return n;
};
export const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
