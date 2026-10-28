export type OccupationDirectionInput = { id?: string; name: string };

export type OccupationDirection = {
  id: string;
  name: string;
  directionCode: string;
  code: string;
};

export type StoredOccupationDirection = {
  id: string;
  name: string;
  ordinal: number;
  status: "active" | "archived";
};

export class OccupationOperationError extends Error {}

export function formatDirectionCode(ordinal: number): string {
  return String(ordinal).padStart(2, "0");
}

export function toOccupationDirection(
  direction: Pick<StoredOccupationDirection, "id" | "name" | "ordinal">,
  occupationCode: string,
): OccupationDirection {
  const directionCode = formatDirectionCode(direction.ordinal);
  return { id: direction.id, name: direction.name, directionCode, code: `${occupationCode}-${directionCode}` };
}

export function planOccupationDirections(
  input: readonly OccupationDirectionInput[],
  existing: readonly StoredOccupationDirection[],
): { retained: StoredOccupationDirection[]; added: { name: string; ordinal: number }[]; archivedIds: string[] } {
  const names = new Set<string>();
  const ids = new Set<string>();
  const retained: StoredOccupationDirection[] = [];
  const added: { name: string; ordinal: number }[] = [];
  let ordinal = Math.max(0, ...existing.map((direction) => direction.ordinal));

  for (const direction of input) {
    const name = direction.name.trim();
    if (!name || name.length > 200) {
      throw new OccupationOperationError("职业方向名称须为 1 至 200 个字符。");
    }
    const key = name.toLowerCase();
    if (names.has(key)) {
      throw new OccupationOperationError("职业方向名称不能重复。");
    }
    names.add(key);
    if (direction.id !== undefined) {
      const stored = existing.find((item) => item.id === direction.id && item.status === "active");
      if (!stored || ids.has(direction.id)) {
        throw new OccupationOperationError("职业方向不存在、已移除或重复提交，请刷新后重试。");
      }
      ids.add(direction.id);
      retained.push({ ...stored, name });
    } else {
      // Archived direction numbers remain reserved for historical references.
      added.push({ name, ordinal: ++ordinal });
    }
  }

  return {
    retained,
    added,
    archivedIds: existing.filter((direction) => direction.status === "active" && !ids.has(direction.id)).map((direction) => direction.id),
  };
}
