import { requireUser, requirePerm } from "@/lib/auth";
import { importAction } from "@/app/actions";
import { ImportForm } from "@/components/ImportForm";
import { PageHeader } from "@/components/ui";

export default async function ImportPage() {
  const me = await requireUser();
  requirePerm(me, "leads.import");
  return (
    <div className="max-w-4xl">
      <PageHeader title="Import leads from CSV" sub="Upload, review the check results, then confirm. Duplicates (same website, company or contact email) are skipped unless you choose otherwise." />
      <ImportForm action={importAction} />
    </div>
  );
}
