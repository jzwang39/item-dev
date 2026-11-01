import React from "react";

export function ExecutionProgress({ generated, target, started }: {
  generated: number; target: number; started: boolean;
}) {
  const total = Number.isFinite(target) ? Math.max(0, target) : 0;
  const completed = Number.isFinite(generated) ? Math.max(0, generated) : 0;
  if (!total) return <span className="text-sm text-[#7185a5]">未制定题量</span>;
  const percent = Math.min(100, Math.floor(completed * 100 / total));
  return (
    <div className="min-w-[150px] text-sm">
      <p className="m-0 whitespace-nowrap text-[#34445d]">{started ? "已生成" : "未开始"} {completed} / {total} 道</p>
      <div className="mt-2 flex items-center gap-2">
        <div
          role="progressbar" aria-label="执行进度" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(completed, total)}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#dfe8f8]"
        >
          <div className="h-full rounded-full bg-[#4160ec]" style={{ width: `${percent}%` }} />
        </div>
        <span className="text-xs text-[#6980a4]">{percent}%</span>
      </div>
    </div>
  );
}
