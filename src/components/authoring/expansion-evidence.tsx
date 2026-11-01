import React from "react";

export type ExpansionDocumentPreview = {
  id: string; title: string; url: string; text: string; retrievedAt: string;
  publication?: string; locator?: string; acquisition?: string;
};

export function ExpansionEvidence({ documents }: { documents?: ExpansionDocumentPreview[] }) {
  if (!documents?.length) return null;
  return (
    <details className="mt-2 text-[#385578]">
      <summary className="cursor-pointer">已载入参考原文（{documents.length}份，载入不代表试题通过）</summary>
      {documents.map((document) => (
        <div key={document.id} className="mt-2 rounded-lg border border-[#dbe4f3] bg-white p-3 text-sm">
          <p className="m-0 font-medium">{document.title}</p>
          {document.publication ? <p className="mb-0 mt-1">{document.publication}</p> : null}
          <p className="mb-0 mt-1 break-all">出处：{document.url}</p>
          {document.locator ? <p className="mb-0 mt-1">定位：{document.locator}</p> : null}
          <p className="mb-0 mt-1">获取时间：{document.retrievedAt}</p>
          {document.acquisition ? <p className="mb-0 mt-1">{document.acquisition}</p> : null}
          <blockquote className="mx-0 mb-0 mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words border-l-2 border-[#b9cae5] pl-3">
            {document.text}
          </blockquote>
        </div>
      ))}
    </details>
  );
}
