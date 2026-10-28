import React, { type ReactNode } from "react";

export function LegalDialogFooter({ error, children }: Readonly<{ error: string; children: ReactNode }>) {
  return <footer className="shrink-0 border-t border-[#e1e7f0] px-6 py-4">
    {error ? <p role="alert" className="m-0 mb-3 max-h-24 overflow-y-auto break-words rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
    <div className="flex justify-end gap-3">{children}</div>
  </footer>;
}
