/**
 * Decode-once layer bitmap cache.
 *
 * This is the piece that guarantees "toggling a layer never re-decodes": the
 * worker wraps ag-psd's `getLayerCanvas()` in one of these, and every later
 * visibility change only reads bitmaps back out of it. The class is fully
 * DOM-free (the decoder is injected), so the invariant is unit-tested in
 * `layer-composite.test.ts`.
 */

export interface DecodeStats {
  /** Successful decoder invocations (the number that must not grow on toggles). */
  decodes: number;
  /** Cache hits. */
  hits: number;
  /** Decode attempts that threw. */
  failures: number;
}

interface Entry<T> {
  value?: T;
  pending?: Promise<T>;
}

export interface EnsureResult {
  decoded: number;
  failed: string[];
  /** Ids that were already cached before this call. */
  cached: number;
}

/** Anything with an optional release hook (`ImageBitmap#close`). */
export interface Closeable {
  close?: () => void;
}

export class LayerBitmapCache<T extends Closeable = ImageBitmap> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly counters: DecodeStats = { decodes: 0, hits: 0, failures: 0 };

  /** `decode` is called at most once per id (concurrent callers share the promise). */
  constructor(private readonly decode: (id: string) => Promise<T>) {}

  get stats(): Readonly<DecodeStats> {
    return this.counters;
  }

  /** Number of successfully decoded layers - the toggle proof counter. */
  get decodeCount(): number {
    return this.counters.decodes;
  }

  /** True when the bitmap is present and ready to draw. */
  has(id: string): boolean {
    return this.entries.get(id)?.value !== undefined;
  }

  /** Synchronous read for the compositor (undefined while a decode is in flight). */
  peek(id: string): T | undefined {
    return this.entries.get(id)?.value;
  }

  /**
   * Insert an already-decoded bitmap (IndexedDB restore). Deliberately does NOT
   * touch the decode counter: a cache hit must stay at 0 decodes.
   */
  set(id: string, value: T): void {
    const existing = this.entries.get(id);
    if (existing?.value && existing.value !== value) existing.value.close?.();
    this.entries.set(id, { value });
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Cached ids with a ready bitmap. */
  readyIds(): string[] {
    return [...this.entries.entries()].filter(([, entry]) => entry.value !== undefined).map(([id]) => id);
  }

  async get(id: string): Promise<T> {
    const entry = this.entries.get(id);
    if (entry?.value !== undefined) {
      this.counters.hits += 1;
      return entry.value;
    }
    if (entry?.pending) return entry.pending;

    const pending = this.decode(id).then(
      (value) => {
        this.entries.set(id, { value });
        this.counters.decodes += 1;
        return value;
      },
      (error: unknown) => {
        this.entries.delete(id);
        this.counters.failures += 1;
        throw error;
      },
    );
    this.entries.set(id, { pending });
    return pending;
  }

  /** Decode everything missing, sequentially, reporting after each layer. */
  async ensure(
    ids: readonly string[],
    onProgress?: (info: { id: string; decoded: number; total: number; cached: number }) => void,
  ): Promise<EnsureResult> {
    const failed: string[] = [];
    let decoded = 0;
    let cached = 0;
    for (const [index, id] of ids.entries()) {
      if (this.has(id)) {
        cached += 1;
        onProgress?.({ id, decoded: index + 1, total: ids.length, cached });
        continue;
      }
      try {
        await this.get(id);
        decoded += 1;
      } catch {
        failed.push(id);
      }
      onProgress?.({ id, decoded: index + 1, total: ids.length, cached });
    }
    return { decoded, failed, cached };
  }

  delete(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.value) entry.value.close?.();
    this.entries.delete(id);
  }

  /** Drop everything and release GPU/CPU memory held by the bitmaps. */
  clear(): void {
    for (const entry of this.entries.values()) entry.value?.close?.();
    this.entries.clear();
  }
}
