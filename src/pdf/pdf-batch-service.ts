import type { PdfService } from "./pdf-service";

interface ZipEntry {
  filename: string;
  data: Buffer;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function uint16(value: number): Buffer {
  const output = Buffer.allocUnsafe(2);
  output.writeUInt16LE(value, 0);
  return output;
}

function uint32(value: number): Buffer {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32LE(value >>> 0, 0);
  return output;
}

function uniqueFilenames(entries: ZipEntry[]): ZipEntry[] {
  const used = new Set<string>();
  return entries.map((entry) => {
    const extensionIndex = entry.filename.lastIndexOf(".");
    const stem = extensionIndex > 0 ? entry.filename.slice(0, extensionIndex) : entry.filename;
    const extension = extensionIndex > 0 ? entry.filename.slice(extensionIndex) : "";
    let filename = entry.filename;
    let number = 2;
    while (used.has(filename)) filename = `${stem}-${number++}${extension}`;
    used.add(filename);
    return { ...entry, filename };
  });
}

function zip(entries: ZipEntry[]): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;
  for (const entry of uniqueFilenames(entries)) {
    const filename = Buffer.from(entry.filename, "utf8");
    const checksum = crc32(entry.data);
    const flags = 0x0800;
    const local = Buffer.concat([
      uint32(0x0403_4b50), uint16(20), uint16(flags), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(entry.data.length), uint32(entry.data.length),
      uint16(filename.length), uint16(0), filename, entry.data,
    ]);
    localRecords.push(local);
    centralRecords.push(Buffer.concat([
      uint32(0x0201_4b50), uint16(20), uint16(20), uint16(flags), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(entry.data.length), uint32(entry.data.length),
      uint16(filename.length), uint16(0), uint16(0), uint16(0), uint16(0), uint32(0), uint32(offset), filename,
    ]));
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  return Buffer.concat([
    ...localRecords,
    centralDirectory,
    uint32(0x0605_4b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(centralDirectory.length), uint32(offset), uint16(0),
  ]);
}

export class PdfBatchService {
  constructor(private readonly pdfService: Pick<PdfService, "getOrCreate">) {}

  async exportBatch(ownerId: string, reviewIds: string[]): Promise<{ data: Buffer; filename: string }> {
    const entries: ZipEntry[] = [];
    for (const reviewId of reviewIds) {
      const pdf = await this.pdfService.getOrCreate(ownerId, reviewId);
      entries.push({ filename: pdf.filename, data: pdf.data });
    }
    return { data: zip(entries), filename: "作文批改批量导出.zip" };
  }
}
