import { query } from "./src/shared/database/mysql";
async function main() {
  const occs = await query("SELECT id, name FROM project_occupations") as any[];
  const quanmu = occs.find(o => o.name === '劝募员');
  
  const structureRows = await query(
    `SELECT b.occupation_id, b.level_code, v.snapshot_json FROM blueprints b
     INNER JOIN blueprint_versions v ON v.id=b.current_version_id
    WHERE b.assessment_mode='skill' AND b.blueprint_kind='skill_structure' AND b.occupation_id=? AND b.level_code='level_5' LIMIT 1`, [quanmu.id]
  ) as any[];
  
  const struct = typeof structureRows[0].snapshot_json === 'string' ? JSON.parse(structureRows[0].snapshot_json) : structureRows[0].snapshot_json;
  const validNames = struct.rows.map((r: any) => r.name.replace(/\s*[A-Z]$/, "").trim());
  console.log("Valid names:", validNames);
  
  const outlineRows = await query(
    `SELECT bn.requirement_json
     FROM blueprints b INNER JOIN blueprint_nodes bn ON bn.blueprint_version_id=b.current_version_id
    WHERE b.occupation_id=? AND b.level_code='level_5' AND b.assessment_mode='skill'
      AND b.blueprint_kind='skill_outline' AND bn.node_kind='assessment_point'
    ORDER BY bn.ordinal,bn.id`, [quanmu.id]
  ) as any[];
  
  const groups = new Map();
  for (const row of outlineRows) {
    const req = typeof row.requirement_json === 'string' ? JSON.parse(row.requirement_json) : row.requirement_json;
    
    let primary = "";
    let secondary = "";
    
    const l1 = req.level1Name?.replace(/\s*[A-Z]$/, "").trim();
    const l2 = req.level2Name?.replace(/\s*[A-Z]$/, "").trim();
    const l3 = req.level3Name?.replace(/\s*[A-Z]$/, "").trim();
    
    if (validNames.includes(l1)) { primary = l1; secondary = l2 || l3; }
    else if (validNames.includes(l2)) { primary = l2; secondary = req.sourceStandardRequirement?.contentName || l3; }
    else if (validNames.includes(l3)) { primary = l3; secondary = req.sourceStandardRequirement?.contentName || l3; }
    else if (validNames.includes(req.sourceStandardRequirement?.functionName)) {
      primary = req.sourceStandardRequirement.functionName;
      secondary = req.sourceStandardRequirement.contentName;
    }
    
    // Fallback if no match
    if (!primary) {
      primary = l1;
      secondary = l2;
    }
    
    if (secondary === primary) secondary = ""; // don't repeat
    
    if (!groups.has(primary)) groups.set(primary, new Set());
    if (secondary) groups.get(primary).add(secondary);
  }
  
  for (const [p, s] of groups.entries()) {
    console.log(p, ":", Array.from(s).join(", "));
  }
  
  process.exit(0);
}
main().catch(console.error);
