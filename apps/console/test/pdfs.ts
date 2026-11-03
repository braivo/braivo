// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// PDFs for the reader's tests, written byte by byte so each one is exactly the
// case it names: no generator dependency, and no font file but the standard 14's.

/** An object's body: a dictionary or other value, or a stream's dictionary and bytes. */
type PdfObject = string | { dict: string; bytes: Uint8Array };

const encoder = new TextEncoder();

/**
 * A PDF of `objects`, numbered from 1, the first its catalog; `trailer` adds
 * to the trailer's dictionary. Offsets are exact, so pdf.js reads it without
 * repairing it.
 */
export function pdf(objects: PdfObject[], trailer = ""): File {
  const parts: Uint8Array[] = [];
  let length = 0;
  const write = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    parts.push(bytes);
    length += bytes.length;
  };
  write("%PDF-1.7\n");
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    write(`${index + 1} 0 obj\n`);
    if (typeof object === "string") {
      write(object);
    } else {
      write(`<< ${object.dict} /Length ${object.bytes.length} >>\nstream\n`);
      write(object.bytes);
      write("\nendstream");
    }
    write("\nendobj\n");
  }
  const xref = length;
  write(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) write(`${String(offset).padStart(10, "0")} 00000 n \n`);
  write(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`,
  );
  return new File(parts as BlobPart[], "test.pdf", { type: "application/pdf" });
}

/** A content stream drawing `lines` in Helvetica from the top of a Letter page, 16 pt apart. */
function textStream(lines: readonly string[]): { dict: string; bytes: Uint8Array } {
  const escaped = lines.map((line) => line.replace(/[\\()]/g, (char) => `\\${char}`));
  const shown = escaped.map((line, index) => `${index === 0 ? "" : "0 -16 Td "}(${line}) Tj`);
  return { dict: "", bytes: encoder.encode(`BT /F1 12 Tf 72 720 Td ${shown.join(" ")} ET`) };
}

const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
/** A 1×1 grey image, as a scan is to a reader that sees only that an image is there. */
const IMAGE = {
  dict: "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8",
  bytes: new Uint8Array([0x80]),
};

export type TestPage = {
  /** Lines of text, drawn from the top. */
  lines?: string[];
  /** A full-page image under the text, as a scan. */
  scan?: boolean;
  /** A content stream of its own, in place of the lines'. */
  content?: { dict: string; bytes: Uint8Array };
};

/**
 * A document of `pages`. `labels` is its `/PageLabels` number tree, such as
 * `[0 << /S /r >> 1 << /S /D >>]`; `kids` lists the page tree's kids in
 * place of its pages, by object number (the tree itself is object 2).
 */
export function document(
  pages: TestPage[],
  options: { labels?: string; kids?: (pages: number[]) => number[]; trailer?: string } = {},
): File {
  // 1 catalog, 2 page tree, 3 font, 4 image, then each page and its contents.
  const pageNumbers = pages.map((_, index) => 5 + index * 2);
  const kids = (options.kids?.(pageNumbers) ?? pageNumbers).map((n) => `${n} 0 R`).join(" ");
  const objects: PdfObject[] = [
    `<< /Type /Catalog /Pages 2 0 R ${options.labels ? `/PageLabels << /Nums ${options.labels} >>` : ""} >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    FONT,
    IMAGE,
  ];
  for (const [index, page] of pages.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${6 + index * 2} 0 R >>`,
    );
    const text = page.content ?? textStream(page.lines ?? []);
    objects.push(
      page.scan
        ? {
            dict: text.dict,
            bytes: concat(encoder.encode("q 612 0 0 792 0 0 cm /Im1 Do Q "), text.bytes),
          }
        : text,
    );
  }
  return pdf(objects, options.trailer);
}

/**
 * A PDF locked with an open password: a standard security handler whose
 * check no password, the empty one included, can pass.
 */
export function locked(): File {
  const zeros = "00".repeat(32);
  return pdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [] /Count 0 >>",
      `<< /Filter /Standard /V 1 /R 2 /O <${"11".repeat(32)}> /U <${"22".repeat(32)}> /P -4 >>`,
    ],
    `/Encrypt 3 0 R /ID [<${zeros}> <${zeros}>]`,
  );
}

/**
 * A page whose one content stream, compressed twice, expands to `bytes` of
 * spaces: small on disk, slow to read, the shape of a decompression bomb.
 */
export async function bomb(bytes: number): Promise<File> {
  const spaces = new Uint8Array(1 << 20).fill(0x20);
  let left = bytes;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left <= 0) return controller.close();
      const chunk = spaces.subarray(0, Math.min(left, spaces.length));
      left -= chunk.length;
      controller.enqueue(chunk);
    },
  });
  const deflate = (stream: ReadableStream<Uint8Array>) =>
    stream.pipeThrough(
      new CompressionStream("deflate") as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
  const twice = new Uint8Array(await new Response(deflate(deflate(source))).arrayBuffer());
  return document([{ content: { dict: "/Filter [/FlateDecode /FlateDecode]", bytes: twice } }]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}
