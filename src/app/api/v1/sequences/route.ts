import { route } from "@/lib/api";
import { listSequences, seqSettings } from "@/lib/service/sequences";
export const GET = route(async () => ({ sequences: await listSequences(), settings: await seqSettings() }));
