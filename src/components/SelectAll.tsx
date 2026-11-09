"use client";
export function SelectAll({ name }: { name: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" onChange={(e) => { const f = e.currentTarget.form; f?.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((c) => (c.checked = e.currentTarget.checked)); }} /> Select all
    </label>
  );
}
