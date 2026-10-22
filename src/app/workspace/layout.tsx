import { redirect } from "next/navigation";

import { getVerifiedSession } from "@/auth";
import { AppShell } from "@/components/workspace/app-shell";

export default async function WorkspaceLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await getVerifiedSession();
  if (!session?.user) {
    redirect("/");
  }

  return (
    <AppShell displayName={session.user.name ?? "未命名用户"} role={session.user.role}>
      {children}
    </AppShell>
  );
}
