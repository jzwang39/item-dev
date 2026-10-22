"use client";

import { signOut } from "next-auth/react";

export function LogoutButton() {
  return (
    <button
      className="rounded-lg px-3 py-2 text-sm text-[#768091] transition hover:bg-slate-100 hover:text-[#293242]"
      onClick={() => signOut({ callbackUrl: "/" })}
      type="button"
    >
      退出登录
    </button>
  );
}
