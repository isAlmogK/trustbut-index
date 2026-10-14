import { fileId, type ManifestEntry } from '../types.js';

export function batchMatrix(entries: ManifestEntry[], batch: number, size = 250): { include: { id: string; entry: string }[] } {
  return {
    include: entries.slice(batch * size, (batch + 1) * size).map((e) => ({ id: fileId(e), entry: JSON.stringify(e) })),
  };
}
