// The display face's subset (public/fonts/anton.woff2, made by scripts/subset-anton.sh) must draw what people
// type: names with accents, brackets, quotes, £ and €. A missing glyph is drawn in a fallback face in the middle
// of an Anton word. The file is read here without a font library: WOFF2's table directory, then its one Brotli
// stream, then the cmap table.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const KNOWN_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep"];

/** WOFF2's UIntBase128: up to five bytes, seven bits each. */
function base128(buf: Buffer, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[at + i] ?? 0;
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return [value, at + i + 1];
  }
  throw new Error("bad UIntBase128");
}

/** The cmap table's bytes, out of a WOFF2 file. */
function cmapOf(file: Buffer): Buffer {
  if (file.toString("latin1", 0, 4) !== "wOF2") throw new Error("not WOFF2");
  const numTables = file.readUInt16BE(12);
  const compressedLength = file.readUInt32BE(20);
  let at = 48;
  const tables: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = file[at++] ?? 0;
    const index = flags & 0x3f;
    let tag: string;
    if (index === 63) {
      tag = file.toString("latin1", at, at + 4);
      at += 4;
    } else {
      tag = index < KNOWN_TAGS.length ? (KNOWN_TAGS[index] ?? "") : `#${index}`;
    }
    const version = flags >> 6;
    let length: number;
    [length, at] = base128(file, at);
    // glyf and loca are transformed unless version 3; any other table is transformed unless version 0.
    const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
    if (transformed) [length, at] = base128(file, at);
    tables.push({ tag, length });
  }
  const data = brotliDecompressSync(file.subarray(at, at + compressedLength));
  let offset = 0;
  for (const t of tables) {
    if (t.tag === "cmap") return data.subarray(offset, offset + t.length);
    offset += t.length;
  }
  throw new Error("no cmap");
}

/** Every code point the cmap maps to a glyph (formats 4 and 12, Windows Unicode subtables). */
function codePoints(cmap: Buffer): Set<number> {
  const out = new Set<number>();
  const count = cmap.readUInt16BE(2);
  for (let i = 0; i < count; i++) {
    const platform = cmap.readUInt16BE(4 + i * 8);
    const encoding = cmap.readUInt16BE(6 + i * 8);
    const at = cmap.readUInt32BE(8 + i * 8);
    if (platform !== 3 && platform !== 0) continue;
    const format = cmap.readUInt16BE(at);
    if (format === 4) {
      const segs = cmap.readUInt16BE(at + 6) / 2;
      const ends = at + 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const ranges = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const end = cmap.readUInt16BE(ends + s * 2);
        const start = cmap.readUInt16BE(starts + s * 2);
        const delta = cmap.readInt16BE(deltas + s * 2);
        const rangeAt = ranges + s * 2;
        const range = cmap.readUInt16BE(rangeAt);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          const glyph = range === 0 ? (c + delta) & 0xffff : cmap.readUInt16BE(rangeAt + range + (c - start) * 2);
          if (glyph !== 0) out.add(c);
        }
      }
    } else if (format === 12 && encoding !== 1) {
      const groups = cmap.readUInt32BE(at + 12);
      for (let g = 0; g < groups; g++) {
        const start = cmap.readUInt32BE(at + 16 + g * 12);
        const end = cmap.readUInt32BE(at + 20 + g * 12);
        for (let c = start; c <= end; c++) out.add(c);
      }
    }
  }
  return out;
}

const font = readFileSync(resolve(import.meta.dirname, "../public/fonts/anton.woff2"));
const covered = codePoints(cmapOf(font));
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const missing = (points: number[]): string[] => points.filter((c) => !covered.has(c)).map((c) => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`);

describe("the display face draws what people type", () => {
  it("Basic Latin: letters, digits, brackets, quotes, & £ $ @ # +", () => {
    expect(missing(range(0x20, 0x7e))).toEqual([]);
  });

  it("Latin-1 Supplement and Latin Extended-A: accented names (José, Zoë, Łódź), £, ·", () => {
    expect(missing(range(0xa0, 0x17f).filter((c) => c !== 0xad))).toEqual([]);
  });

  it("typographic quotes and dashes, the bullet, the ellipsis and €", () => {
    expect(missing([0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2022, 0x2026, 0x20ac])).toEqual([]);
  });

  it("stays a small file (it is preloaded on both pages)", () => {
    expect(font.length).toBeLessThan(24 * 1024);
  });
});
