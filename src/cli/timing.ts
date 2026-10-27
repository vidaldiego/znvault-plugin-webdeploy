import type { PhaseTiming } from './types.js';

/** Timing entries contain fixed phase labels and public host/byte metadata only. */
export class Timings {
  readonly entries: PhaseTiming[] = [];
  async measure<T>(phase: string, host: string | undefined, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const entry: PhaseTiming = { phase, ...(host ? { host } : {}), durationMs: 0, success: false };
    this.entries.push(entry);
    try {
      const value = await fn();
      const outcome = value as {success?: boolean; ok?: boolean; allMatch?: boolean; transferredBytes?: number} | undefined;
      entry.success = outcome?.success !== false && outcome?.ok !== false && outcome?.allMatch !== false;
      if (outcome?.transferredBytes !== undefined) entry.transferredBytes = outcome.transferredBytes;
      return value;
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { timings: this.entries });
      throw error;
    } finally { entry.durationMs = Math.round((performance.now() - start) * 100) / 100; }
  }
}
