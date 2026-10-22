import { redirect } from "next/navigation";

import { getVerifiedSession } from "@/auth";
import { ChangePassword } from "@/components/settings/change-password";

export default async function PasswordSettingsPage() {
  const session = await getVerifiedSession();
  if (!session?.user) {
    redirect("/");
  }

  return <ChangePassword />;
}
