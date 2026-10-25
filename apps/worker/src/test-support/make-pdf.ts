/**
 * A minimal valid PDF with one line of text per page.
 *
 * The caller stamps a per-run tag into the text: the dev database is shared,
 * never truncated, and dedups on sha256, so a fixture whose bytes repeat from
 * one run to the next ingests nothing the second time.
 */
export function makePdf(lines: string[]): Buffer {
  const n = lines.length;
  const kids = lines.map((_, i) => `${3 + 2 * i} 0 R`).join(" ");
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`,
  ];
  lines.forEach((line, i) => {
    const content = `BT /F1 14 Tf 72 760 Td (${line.replace(/[()\\]/g, "")}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${3 + 2 * n} 0 R >> >> /Contents ${4 + 2 * i} 0 R >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
