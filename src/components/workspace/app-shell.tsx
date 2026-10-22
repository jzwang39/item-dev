"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { AccountMenu } from "@/components/workspace/account-menu";
import type { AccountRole } from "@/modules/auth/repository";

const navigation = [
  { label: "工作台", href: "/workspace", icon: "▦" },
  { label: "智能命题", href: "/workspace/authoring", icon: "✦" },
  { label: "专家审定", href: "/workspace/review", icon: "✓" },
  { label: "题库管理", href: "/workspace/questions", icon: "▤" },
  { label: "智能组卷", href: "/workspace/assembly", icon: "▧" }
];

export function AppShell({
  children,
  displayName,
  role
}: Readonly<{
  children: React.ReactNode;
  displayName: string;
  role: AccountRole;
}>) {
  const pathname = usePathname();
  const visibleNavigation = role === "expert"
    ? navigation.filter((item) => ["/workspace", "/workspace/review", "/workspace/questions"].includes(item.href))
    : navigation;

  return (
    <div className="min-h-screen bg-[#f8f9fc]">
      <header className="border-b border-[#e7eaf0] bg-white">
        <div className="mx-auto flex min-h-[74px] max-w-brand items-center justify-between px-9">
          <Link className="flex items-center gap-3 no-underline" href="/workspace">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#3f60e8] text-sm font-bold text-white">题</div>
            <div>
              <p className="m-0 text-[15px] font-semibold text-[#293242]">技能人才评价国家题库智能命题平台</p>
              <span className="mt-1 inline-block rounded bg-[#f1f3f8] px-1.5 py-0.5 text-[10px] text-[#768091]">
                Beta1.0
              </span>
            </div>
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-sm text-[#768091]">帮助</span>
            <div className="h-8 w-px bg-[#e7eaf0]" />
            <AccountMenu displayName={displayName} role={role} />
          </div>
        </div>
      </header>
      <nav className="border-b border-[#e7eaf0] bg-white">
        <div className="mx-auto flex max-w-brand overflow-x-auto px-6">
          {visibleNavigation.map((item) => (
            <Link
              className={`flex min-h-[49px] shrink-0 items-center gap-2 border-b-[3px] px-[19px] text-[13px] no-underline transition hover:bg-[#f9faff] hover:text-[#415bc5] ${
                pathname === item.href
                  ? "border-[#3f60e8] font-semibold text-[#3f60e8]"
                  : "border-transparent text-[#7c8594]"
              }`}
              href={item.href}
              key={item.href}
            >
              <span aria-hidden>{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
      <main className="mx-auto max-w-workspace px-9 py-8 pb-14">{children}</main>
      <footer className="border-t border-[#e7eaf0] bg-white py-5 text-center text-xs text-[#768091]">
        技能人才评价国家题库智能命题平台
      </footer>
    </div>
  );
}
