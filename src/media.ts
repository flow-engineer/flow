// Media: where the files people send (and files the agent sends) are kept. Flow Framework holds no
// bytes of its own: the team gives a store (`createAgent({ media })`), over its own storage (S3, GCS,
// a database), and Flow Framework only passes ids. Without one, a channel that needs to keep a file
// to take it (the web chat) refuses files. Flow's own storage is `flowMedia()` in
// @flow-engineer/flow/flow-messaging, used only when the team's code passes it.

import { randomUUID } from "node:crypto";

/** A file as a store kept it. */
export interface MediaFile {
  id: string;
  mime: string;
  /** Its size in bytes. */
  size: number;
  name?: string;
}

/**
 * Where an agent's files are kept, the team's own. `owner` is the person the file belongs to, as
 * `<channel>:<address>` (`web:visitor:...`), known before their conversation is, and what `forget` erases.
 */
export interface MediaStore {
  /** Keeps a file; resolves once it is kept. Reject what you will not keep (its type, its size). */
  put(file: { data: Uint8Array; mime: string; name?: string; owner: string }): Promise<MediaFile>;
  /** A file it keeps, or null. */
  get(id: string): Promise<(MediaFile & { data: Uint8Array; owner: string }) | null>;
  /** Erases every file of this owner (the person was forgotten). */
  forget?(owner: string): Promise<void>;
}

/**
 * Files in this process's memory, for local development and tests: at most `maxBytes` in all
 * (default 200 MB, the oldest go first). A restart forgets them.
 */
export function memoryMedia(options: { maxBytes?: number } = {}): MediaStore {
  const most = options.maxBytes ?? 200 * 1_048_576;
  const files = new Map<string, MediaFile & { data: Uint8Array; owner: string }>();
  let total = 0;
  return {
    async put(file) {
      if (file.data.length > most) throw new Error(`a file of ${file.data.length} bytes is over this store's ${most}`);
      const kept = { id: `med_${randomUUID().replace(/-/g, "")}`, mime: file.mime, size: file.data.length, ...(file.name ? { name: file.name } : {}), data: file.data, owner: file.owner };
      files.set(kept.id, kept);
      total += kept.size;
      for (const [id, old] of files) {
        if (total <= most) break;
        files.delete(id);
        total -= old.size;
      }
      const { data: _data, owner: _owner, ...shown } = kept;
      return shown;
    },
    async get(id) {
      return files.get(id) ?? null;
    },
    async forget(owner) {
      for (const [id, file] of files) {
        if (file.owner !== owner) continue;
        files.delete(id);
        total -= file.size;
      }
    },
  };
}

/** The types a person may send a store through Flow Framework's own channels, told by their first bytes. */
export type MediaKind = "image" | "audio" | "document";

/**
 * A file's real type from its first bytes (JPEG, PNG, WebP, GIF, PDF, Ogg, WebM, MP3, MP4/M4A, WAV),
 * or null for anything else: what a browser or a person says a file is never decides it.
 */
export function sniff(data: Uint8Array): { mime: string; kind: MediaKind } | null {
  const at = (offset: number, ...bytes: number[]) => bytes.every((b, i) => data[offset + i] === b);
  const ascii = (offset: number, text: string) => at(offset, ...[...text].map((c) => c.charCodeAt(0)));
  if (at(0, 0xff, 0xd8, 0xff)) return { mime: "image/jpeg", kind: "image" };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: "image/png", kind: "image" };
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return { mime: "image/gif", kind: "image" };
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return { mime: "image/webp", kind: "image" };
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return { mime: "audio/wav", kind: "audio" };
  if (ascii(0, "%PDF-")) return { mime: "application/pdf", kind: "document" };
  if (ascii(0, "OggS")) return { mime: "audio/ogg", kind: "audio" };
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return { mime: "audio/webm", kind: "audio" };
  if (ascii(0, "ID3") || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return { mime: "audio/mpeg", kind: "audio" };
  if (ascii(4, "ftyp")) return { mime: "audio/mp4", kind: "audio" };
  return null;
}
