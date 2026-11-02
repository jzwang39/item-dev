export type CommonTaskSummary = { id: string; generation_status?: string | null };
export function selectCommonTask(groups: CommonTaskSummary[], requestedId: string | null) {
  if (requestedId && groups.some((group) => group.id === requestedId)) return requestedId;
  return groups.find((group) => ["queued", "running"].includes(group.generation_status ?? ""))?.id ?? groups[0]?.id ?? "";
}
