import { redirect } from "next/navigation";

import { getVerifiedSession } from "@/auth";
import { MemberManagement } from "@/components/settings/member-management";

export default async function MembersSettingsPage() {
  const session = await getVerifiedSession();
  if (!session?.user || session.user.role !== "admin") {
    redirect("/workspace");
  }

  return <MemberManagement />;
}
