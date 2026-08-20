#!/usr/bin/env bash
# Regenerates the three extraction fixtures. Requires poppler-utils and
# ImageMagick 7 on the dev machine: brew install poppler imagemagick
#   bash apps/worker/src/fixtures/make-fixtures.sh
# The generated files are committed; this script exists so they are
# reproducible rather than mysterious binaries.
set -euo pipefail
cd "$(dirname "$0")"

python3 - <<'PY'
lines = [
  "Beste heer Van der Poel,",
  "Hierbij bevestigen wij de opzegging van uw abonnement bij Ziggo.",
  "Uw dossiernummer is 2026-VG-00412. De beeindiging gaat in per 1 oktober 2026.",
  "Wij verzoeken u een kopie van uw paspoort op te sturen voor uw dossier.",
  "Met vriendelijke groet, VerderGroep Bewindvoering",
]
content = "BT\n/F1 14 Tf\n72 760 Td\n18 TL\n" + "".join(f"({l}) Tj\nT*\n" for l in lines) + "ET\n"
objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
out, offs = "%PDF-1.4\n", []
for i, o in enumerate(objs, 1):
    offs.append(len(out)); out += f"{i} 0 obj\n{o}\nendobj\n"
x = len(out)
out += f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offs)
out += f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n"
open("raw-letter.pdf", "w", newline="\n").write(out)
PY

pdftocairo -pdf raw-letter.pdf text-letter.pdf
pdftoppm -png -r 100 -f 1 -l 1 text-letter.pdf scan && mv scan-1.png scan-letter.png
magick scan-letter.png scanned-letter.pdf
rm raw-letter.pdf
echo "fixtures: $(ls -1 text-letter.pdf scan-letter.png scanned-letter.pdf)"
