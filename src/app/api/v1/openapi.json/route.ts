import { openApiSpec } from "@/lib/openapi";
/** Machine-readable description of the API (OpenAPI 3.1). No key needed: it describes the API, it holds no data. */
export async function GET(req: Request) {
  return Response.json(openApiSpec(new URL(req.url).origin));
}
