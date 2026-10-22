import { redirect } from "next/navigation";
import type { RowDataPacket } from "mysql2";

import { getVerifiedSession } from "@/auth";
import { ModelSettings } from "@/components/settings/model-settings";
import { query } from "@/shared/database/mysql";

export default async function ModelSettingsPage() {
  const session = await getVerifiedSession();
  if (!session?.user || session.user.role !== "admin") {
    redirect("/workspace");
  }

  const rows = await query<(RowDataPacket & { total: number })[]>(
    "SELECT COUNT(*) AS total FROM projects WHERE status = 'active'"
  );

  return <ModelSettings projectCount={rows[0]?.total ?? 0} />;
}
