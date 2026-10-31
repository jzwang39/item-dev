import React from "react";

export function SupplementButton({ enabled, busy, onClick, className }: {
  enabled: boolean; busy: boolean; onClick: () => void; className?: string;
}) {
  return (
    <button
      type="button"
      className={className ?? "ml-3 rounded-xl border border-[#b9cae5] bg-white px-4 py-2.5 text-sm font-medium text-[#385578] disabled:opacity-50"}
      disabled={!enabled || busy}
      title={enabled ? "仅按冻结计划最低题量补齐缺额，保留已有成果" : "停止生成并保留成果后，题量不足时可补题"}
      onClick={onClick}
    >
      {busy ? "补题启动中..." : "补题"}
    </button>
  );
}
