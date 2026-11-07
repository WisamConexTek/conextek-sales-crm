import { all, one, run, getListMap } from "../db";
import { HttpError, type Actor } from "../auth";
import { LIST_KINDS, type ListKind } from "../constants";
import { audit, slugify } from "./common";

const KINDS = LIST_KINDS.map((k) => k.kind);

export async function getLists(includeInactive = false) {
  const rows = await all(`SELECT * FROM lists ${includeInactive ? "" : "WHERE active=1"} ORDER BY kind, position, id`);
  const out: Record<string, typeof rows> = {};
  for (const k of KINDS) out[k] = [];
  for (const r of rows) (out[r.kind] ??= []).push(r);
  return out;
}

export async function labels(kind: ListKind) {
  return getListMap(kind);
}

function ownerOnly(actor: Actor) {
  if (actor.role !== "owner") throw new HttpError(403, "Only the owner can edit lists.");
}
function checkKind(kind: string): asserts kind is ListKind {
  if (!KINDS.includes(kind as ListKind)) throw new HttpError(400, "Unknown list.");
}
function checkFlag(kind: string, flag: string | null) {
  if (!flag) return null;
  const ok = kind === "stage" ? ["won", "lost", "closed", "meeting", "replied"] : kind === "task_type" ? ["chief", "wisam"] : [];
  if (!ok.includes(flag)) throw new HttpError(400, `Invalid flag for ${kind}.`);
  return flag;
}

export async function addItem(actor: Actor, kind: string, label: string, flag: string | null) {
  ownerOnly(actor);
  checkKind(kind);
  label = label.trim();
  if (!label) throw new HttpError(400, "Name is required.");
  if (kind === "task_type" && !flag) flag = "chief";
  let key = slugify(label);
  while (await one("SELECT id FROM lists WHERE kind=? AND key=?", [kind, key])) key += "_2";
  const pos = Number((await one("SELECT COALESCE(MAX(position),0)+1 AS p FROM lists WHERE kind=?", [kind]))!.p);
  const r = await run("INSERT INTO lists (kind,key,label,flag,position) VALUES (?,?,?,?,?)", [kind, key, label, checkFlag(kind, flag), pos]);
  await audit(actor, "add_list_item", "list", r.id, { kind, label, flag });
}

export async function updateItem(actor: Actor, id: number, patch: { label?: string; flag?: string | null; active?: boolean }) {
  ownerOnly(actor);
  const it = await one("SELECT * FROM lists WHERE id=?", [id]);
  if (!it) throw new HttpError(404, "Item not found.");
  const label = patch.label?.trim() || it.label;
  const flag = patch.flag === undefined ? it.flag : checkFlag(it.kind, patch.flag || null);
  const active = patch.active === undefined ? it.active : patch.active ? 1 : 0;
  if (!active && it.kind === "stage") {
    const left = Number((await one("SELECT COUNT(*) AS n FROM lists WHERE kind='stage' AND active=1 AND id<>?", [id]))!.n);
    if (left < 1) throw new HttpError(400, "At least one stage must stay active.");
  }
  await run("UPDATE lists SET label=?, flag=?, active=? WHERE id=?", [label, flag, active, id]);
  await audit(actor, "update_list_item", "list", id, {
    kind: it.kind, before: { label: it.label, flag: it.flag, active: it.active }, after: { label, flag, active },
  });
}

export async function move(actor: Actor, id: number, dir: -1 | 1) {
  ownerOnly(actor);
  const it = await one("SELECT * FROM lists WHERE id=?", [id]);
  if (!it) return;
  const rows = await all("SELECT id,position FROM lists WHERE kind=? ORDER BY position,id", [it.kind]);
  const i = rows.findIndex((r) => r.id === id);
  const j = i + dir;
  if (j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  for (let n = 0; n < rows.length; n++) await run("UPDATE lists SET position=? WHERE id=?", [n, rows[n].id]);
  await audit(actor, "reorder_list", "list", id, { kind: it.kind, dir });
}
