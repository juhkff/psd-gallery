import { describe, expect, it } from 'vitest';
import {
  MAX_PSD_BYTES,
  extensionOf,
  isValidDate,
  listDrafts,
  nextIndex,
  planUploads,
  publishMessage,
  sanitizeStem,
  usedIndexes,
  type DirReader,
} from './upload-plan';

/** In-memory DirReader: keys are repo-relative paths. */
function fakeFs(files: Record<string, number>): DirReader {
  return {
    list(dir) {
      const prefix = `${dir}/`;
      return Object.keys(files)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .filter((name) => !name.includes('/'));
    },
    isFile: (target) => target in files,
    size: (target) => files[target] ?? 0,
  };
}

describe('sanitizeStem', () => {
  it('strips directories and the extension', () => {
    expect(sanitizeStem('sketch.psd')).toBe('sketch');
    expect(sanitizeStem('/tmp/a/b/portrait.psd')).toBe('portrait');
    expect(sanitizeStem('C:\\work\\study.psd')).toBe('study');
  });

  it('neutralises traversal and path-hostile characters', () => {
    expect(sanitizeStem('../../etc/passwd.psd')).toBe('passwd');
    expect(sanitizeStem('..\\..\\evil.psd')).toBe('evil');
    expect(sanitizeStem('a<b>c:d"e|f?g*h.psd')).toBe('a_b_c_d_e_f_g_h');
    expect(sanitizeStem('...hidden.psd')).toBe('hidden');
  });

  it('falls back for empty and Windows-reserved names', () => {
    expect(sanitizeStem('.psd')).toBe('upload');
    expect(sanitizeStem('   .psd')).toBe('upload');
    expect(sanitizeStem('CON.psd')).toBe('upload');
    expect(sanitizeStem('com1.psd')).toBe('upload');
  });

  it('keeps CJK names and truncates long ones', () => {
    expect(sanitizeStem('人物速涂.psd')).toBe('人物速涂');
    expect(sanitizeStem(`${'x'.repeat(200)}.psd`)).toHaveLength(60);
  });
});

describe('extensionOf / isValidDate', () => {
  it('lower-cases the extension', () => {
    expect(extensionOf('A.PSD')).toBe('.psd');
    expect(extensionOf('a.b.psd')).toBe('.psd');
    expect(extensionOf('noext')).toBe('');
  });

  it('accepts only real ISO calendar dates', () => {
    expect(isValidDate('2026-09-21')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('20260921')).toBe(false);
    expect(isValidDate('../2026-09-21')).toBe(false);
  });
});

describe('nextIndex numbers, not names', () => {
  it('takes the smallest free positive integer', () => {
    expect(nextIndex(new Set())).toBe(1);
    expect(nextIndex(new Set([1]))).toBe(2);
    expect(nextIndex(new Set([1, 3]))).toBe(2);
    expect(nextIndex(new Set([2, 3]))).toBe(1);
  });

  it('considers both published works and drafts, ignoring non-numeric stems', () => {
    const fs = fakeFs({
      'works/2026-09-21/1.psd': 10,
      'works/2026-09-21/2.psd': 10,
      'works/2026-09-21/notes.txt': 10,
      'works/.incoming/2026-09-21/3.psd': 10,
      'works/2026-09-22/9.psd': 10,
    });
    expect([...usedIndexes(fs, '2026-09-21')].sort()).toEqual([1, 2, 3]);
    expect([...usedIndexes(fs, '2026-09-22')].sort()).toEqual([9]);
  });
});

describe('planUploads', () => {
  it('assigns ordered numbers inside the requested date folder', () => {
    const plan = planUploads(fakeFs({}), {
      date: '2026-09-21',
      fileNames: ['a.psd', 'b.psd', 'c.psd'],
      sizes: [100, 200, 300],
    });
    expect(plan.rejected).toEqual([]);
    expect(plan.accepted.map((u) => u.publishPath)).toEqual([
      'works/2026-09-21/1.psd',
      'works/2026-09-21/2.psd',
      'works/2026-09-21/3.psd',
    ]);
    expect(plan.accepted.map((u) => u.bytes)).toEqual([100, 200, 300]);
  });

  it('continues after the numbers already used in that date', () => {
    const plan = planUploads(fakeFs({ 'works/2026-09-21/1.psd': 10, 'works/2026-09-21/2.psd': 10 }), {
      date: '2026-09-21',
      fileNames: ['new.psd'],
      sizes: [10],
    });
    expect(plan.accepted[0].publishPath).toBe('works/2026-09-21/3.psd');
    expect(plan.accepted[0].incomingPath).toBe('works/.incoming/2026-09-21/new.psd');
  });

  it('never plans the same number twice within one batch', () => {
    const plan = planUploads(fakeFs({ 'works/2026-09-21/1.psd': 10 }), {
      date: '2026-09-21',
      fileNames: Array.from({ length: 5 }, (_, i) => `f${i}.psd`),
      sizes: [10, 10, 10, 10, 10],
    });
    const numbers = plan.accepted.map((u) => u.index);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual([2, 3, 4, 5, 6]);
  });

  it('rejects bad files per-file without dropping the good ones', () => {
    const plan = planUploads(fakeFs({}), {
      date: '2026-09-21',
      fileNames: ['good.psd', 'notes.txt', 'noext', 'empty.psd', 'huge.psd'],
      sizes: [100, 100, 100, 0, MAX_PSD_BYTES + 1],
    });
    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0].publishPath).toBe('works/2026-09-21/1.psd');
    expect(plan.rejected).toHaveLength(4);
    expect(plan.rejected.map((u) => u.original)).toEqual(['notes.txt', 'noext', 'empty.psd', 'huge.psd']);
    expect(plan.rejected[0].rejection).toContain('只接受');
    expect(plan.rejected[3].rejection).toContain('GitHub 单文件上限');
  });

  it('rejects an invalid date for every file', () => {
    const plan = planUploads(fakeFs({}), {
      date: '2026-09-32',
      fileNames: ['a.psd'],
      sizes: [10],
    });
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected[0].rejection).toContain('YYYY-MM-DD');
  });

  it('keeps a collision-free number even when a hostile name targets works/', () => {
    const plan = planUploads(fakeFs({ 'works/2026-09-21/1.psd': 10, 'works/2026-09-21/2.psd': 10 }), {
      date: '2026-09-21',
      // the name is only a label: it cannot escape the date folder
      fileNames: ['../../../works/2026-09-21/1.psd'],
      sizes: [10],
    });
    expect(plan.accepted[0].publishPath).toBe('works/2026-09-21/3.psd');
    expect(plan.accepted[0].incomingPath).not.toContain('..');
    expect(plan.accepted[0].incomingPath.startsWith('works/.incoming/2026-09-21/')).toBe(true);
  });
});

describe('listDrafts', () => {
  it('lists only psd drafts with sizes, sorted', () => {
    const fs = fakeFs({
      'works/.incoming/2026-09-21/portrait.psd': 500,
      'works/.incoming/2026-09-21/alpha.psd': 100,
      'works/.incoming/2026-09-21/readme.txt': 10,
      'works/.incoming/2026-09-22/other.psd': 20,
    });
    const drafts = listDrafts(fs, 'works/.incoming', '2026-09-21');
    expect(drafts.map((d) => d.stem)).toEqual(['alpha', 'portrait']);
    expect(drafts[0]).toEqual({ path: 'works/.incoming/2026-09-21/alpha.psd', stem: 'alpha', bytes: 100 });
    expect(listDrafts(fs, 'works/.incoming', '2026-01-01')).toEqual([]);
  });
});

describe('publishMessage', () => {
  it('summarises what shipped', () => {
    expect(publishMessage(['2026-09-21'], 1)).toBe('发布 1 件作品（2026-09-21）');
    expect(publishMessage(['2026-09-21', '2026-09-21', '2026-09-24'], 3)).toBe(
      '发布 3 件作品（2026-09-21, 2026-09-24）',
    );
  });
});
