import { getVerifiedSession } from "@/auth";
import { ExpertDashboard } from "@/components/expert/expert-dashboard";

export default async function WorkspacePage() {
  const session = await getVerifiedSession();
  if (session?.user.role === "expert") return <ExpertDashboard />;
  return <ExpertDashboard scope="admin" />;
}
