// Development-only generation. The deployed exporter reads the checked-in PNG
// and does not depend on a native canvas renderer.
import { createCanvas } from "@napi-rs/canvas";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

async function main() {
  const canvas = createCanvas(400, 4850);
  const context = canvas.getContext("2d");
  context.fillStyle = "#000000";
  context.font = "60px SimSun, Songti SC, serif";
  context.textAlign = "left";
  const fields = [["地区", 160], ["姓名", 1160], ["单位\n名称", 2160], ["准考\n证号", 3260]] as const;
  context.lineWidth = 4;
  for (const [label, y] of fields) {
    const lines = label.split("\n");
    lines.forEach((line, index) => context.fillText(line, 10, y + index * 85));
    context.beginPath();
    context.moveTo(10, y + lines.length * 85 + 75);
    context.lineTo(165, y + lines.length * 85 + 75);
    context.stroke();
  }
  context.textAlign = "center";
  [..."考生答题不准超过此线"].forEach((letter, index) => context.fillText(letter, 255, 160 + index * 130));
  context.setLineDash([18, 18]);
  context.beginPath();
  context.moveTo(380, 10);
  context.lineTo(380, 4840);
  context.stroke();
  await writeFile(join(process.cwd(), "public/document-assets/theory-seal-v1.png"), canvas.toBuffer("image/png"));
}
void main();
