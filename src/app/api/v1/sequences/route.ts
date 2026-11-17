import { route } from "@/lib/api";
import { listSequences, seqSettings, createSequence } from "@/lib/service/sequences";
export const GET = route(async () => ({ sequences: await listSequences(), settings: await seqSettings() }));
// Owner: a new sequence (a draft until activated). Give steps[], or copy_from another sequence.
export const POST = route(async ({ actor, body }) => createSequence(actor, await body()));
