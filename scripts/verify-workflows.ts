/**
 * Regression test for the workflow trigger configuration.
 *
 * HONEST SCOPE: this is not GitHub's own evaluator. It parses the real workflow
 * YAML and applies GitHub's documented push-filter rules, which is exactly the
 * rule set the project depends on:
 *
 *   - `branches` / `tags` / `branches-ignore` / `tags-ignore` all accept glob
 *     patterns; a ref matches if it matches any `branches`/`tags` pattern and no
 *     ignore pattern;
 *   - branch and tag filters are INDEPENDENT: a branch ref is only ever tested
 *     against the branch filters, a tag ref only against the tag filters;
 *   - a push is triggered when either the branch or the tag side matches.
 *
 * The consequences this locks in:
 *   * pushing the branch does not build;
 *   * pushing a version tag does build;
 *   * a non-version tag does not build.
 *
 *   npx tsx scripts/verify-workflows.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

interface PushFilters {
  branches?: string[];
  'branches-ignore'?: string[];
  tags?: string[];
  'tags-ignore'?: string[];
  paths?: string[];
  'paths-ignore'?: string[];
}

interface Workflow {
  file: string;
  push?: PushFilters;
}

/** Minimal YAML reader for the tiny subset the trigger blocks use. */
function parseTriggers(file: string): Workflow {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const onIndex = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (onIndex < 0) throw new Error(`${file}: no top-level "on:" block`);

  const push: PushFilters = {};
  let inPush = false;
  let currentKey: keyof PushFilters | null = null;

  for (let i = onIndex + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\S/.test(raw) && raw.trim() !== '') break; // next top-level key
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (line.trim() === '') continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 2) {
      inPush = trimmed.startsWith('push:');
      currentKey = null;
      if (inPush && trimmed.includes(':')) {
        // inline form `push: {}` - not used here
        continue;
      }
      continue;
    }
    if (!inPush) continue;

    const listItem = /^-\s*(.+)$/.exec(trimmed);
    if (listItem && currentKey) {
      (push[currentKey] ??= []).push(listItem[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }

    const pair = /^([a-z-]+):\s*(.*)$/.exec(trimmed);
    if (pair) {
      const key = pair[1] as keyof PushFilters;
      currentKey = key;
      const inline = pair[2].trim();
      if (inline.startsWith('[')) {
        push[key] = inline
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean) as string[];
      } else if (inline === '') {
        push[key] = [];
      } else {
        push[key] = [inline.replace(/^['"]|['"]$/g, '')];
      }
    }
  }
  return { file: path.basename(file), push: Object.keys(push).length > 0 ? push : undefined };
}

/** GitHub glob: `*` does not cross `/`, `**` does, `?` is one char. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withGlobs = escaped
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${withGlobs}$`);
}

function matchesAny(ref: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(ref));
}

/** Would `push` to this ref trigger the workflow? */
function triggers(workflow: Workflow, ref: string): boolean {
  const filters = workflow.push;
  if (!filters) return false;
  const isTag = ref.startsWith('refs/tags/');
  const name = ref.replace(/^refs\/(heads|tags)\//, '');

  if (isTag) {
    // branch filters can never match a tag ref, and vice versa
    if (matchesAny(name, filters['tags-ignore'])) return false;
    return matchesAny(name, filters.tags);
  }
  if (matchesAny(name, filters['branches-ignore'])) return false;
  return matchesAny(name, filters.branches);
}

interface Case {
  ref: string;
  want: boolean;
  why: string;
}

const CASES: Case[] = [
  { ref: 'refs/heads/main', want: false, why: 'push 代码到 main（没有 tag）不构建' },
  { ref: 'refs/heads/feature/x', want: false, why: 'push 功能分支不构建' },
  { ref: 'refs/tags/v1.0.0', want: true, why: '推送版本 tag 才构建' },
  { ref: 'refs/tags/v0.1.0', want: true, why: '版本 tag（早期）构建' },
  { ref: 'refs/tags/v2', want: true, why: 'v 前缀 tag 构建' },
  { ref: 'refs/tags/release-1', want: false, why: '非 v 前缀 tag 不构建' },
  { ref: 'refs/tags/1.0.0', want: false, why: '不带 v 的 tag 不构建' },
];

function main(): void {
  const files = fs
    .readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => path.join(WORKFLOWS, name));
  if (files.length === 0) {
    console.error('no workflows found');
    process.exit(1);
  }

  const workflows = files.map(parseTriggers);
  let failures = 0;

  for (const workflow of workflows) {
    console.log(`\n${workflow.file}`);
    console.log(`  push filters: ${JSON.stringify(workflow.push ?? null)}`);
    for (const testCase of CASES) {
      const actual = triggers(workflow, testCase.ref);
      const ok = actual === testCase.want;
      if (!ok) failures += 1;
      console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${testCase.ref.padEnd(24)} -> ` +
        `${actual ? 'trigger' : 'skip   '} (want ${testCase.want ? 'trigger' : 'skip'})  ${testCase.why}`,
      );
    }

    // The core promise, asserted directly rather than inferred from the list.
    if (!workflow.push) {
      failures += 1;
      console.error(`  FAIL  ${workflow.file} has no push trigger at all`);
      continue;
    }
    if (workflow.push.branches && workflow.push.branches.length > 0) {
      failures += 1;
      console.error('  FAIL  a `branches` filter is present, which can trigger a build on a plain code push');
    }
    if (!workflow.push.tags || workflow.push.tags.length === 0) {
      failures += 1;
      console.error('  FAIL  no `tags` filter, so a tag push would not build');
    }
    if (workflow.push['tags-ignore'] && workflow.push['tags-ignore'].includes('**')
        && (!workflow.push.tags || workflow.push.tags.length === 0)) {
      failures += 1;
      console.error('  FAIL  tags-ignore: ** would disable tag builds entirely');
    }
  }

  console.log(
    failures === 0
      ? '\nWORKFLOW TRIGGERS OK - branch pushes are inert, version tags build'
      : `\n${failures} trigger assertion(s) failed`,
  );
  if (failures > 0) process.exit(1);
}

main();
