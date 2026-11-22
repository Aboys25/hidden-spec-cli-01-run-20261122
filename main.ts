// main.ts is mend, the CLI SPEC.md specifies. It implements all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// with move rows (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Byte order of two paths (UTF-8), as SPEC.md section 2 sorts output rows. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// Files and lines (SPEC.md section 3) and matching lines (section 5)
// ---------------------------------------------------------------------------

function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  if (tier === 1) return t;
  return t.replace(/^[ \t]+/, '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions i where O matches lines[i, i+O.length) at the given tier. Occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const n = o.length;
  if (n === 0) return out;
  const want = o.map((l) => normLine(l, tier));
  for (let i = from; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (from `from`), with its occurrences, or null. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  for (const tier of tiers(strict)) {
    const occ = occurrences(lines, o, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One line of N: `ctx` is the index into O for a context line, -1 for an added line. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * Build the lines that replace the matched range: context lines are the file's own matched lines,
 * every other line is re-indented at tier 2 (section 5) and written as it is at tiers 0 and 1.
 */
function buildReplacement(n: NLine[], lines: string[], pos: number, o: string[], tier: number): string[] {
  return n.map((e) => {
    if (e.ctx >= 0) return lines[pos + e.ctx]!;
    if (tier !== 2) return e.text;
    const f = leadWs(lines[pos] ?? '');
    const p = leadWs(o[0] ?? '');
    const t = e.text;
    if (t.trim() === '' || !t.startsWith(p)) return t;
    return f + t.slice(p.length);
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNL: boolean;
  /** A `\` line follows the hunk's last `+` line (false when it has none). */
  lastPlusNoNL: boolean;
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renFrom: string | null | undefined;
  renTo: string | null | undefined;
  gitOld: string | null | undefined;
  gitNew: string | null | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

function parseDiffGit(line: string, num: number): [string, string] {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  if (!m) throw new Exit2(`error: parse ${num}`);
  return [m[1]!, m[2]!];
}

/** The path of a `--- ` or `+++ ` header line: after the four characters, up to the first tab, trimmed; /dev/null is null. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse one hunk body starting at `j` (the line after the header); returns the index after the body. */
function parseHunk(lines: string[], j: number, sec: Section, a: number): number {
  const body: string[] = [];
  while (j < lines.length) {
    const line = lines[j]!;
    if (isDiffGitLine(line)) break;
    if (line.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
      body.push(line);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const line = body[k]!;
    if (line === '' || line[0] === ' ') {
      const text = line === '' ? '' : line.slice(1);
      o.push(text);
      n.push({ text, ctx: o.length - 1 });
      lastCtxPlus = k;
    } else if (line[0] === '-') {
      o.push(line.slice(1));
    } else if (line[0] === '+') {
      n.push({ text: line.slice(1), ctx: -1 });
      lastCtxPlus = k;
      lastPlus = k;
    }
    // A `\` line refers to the body line before it and adds no O or N line.
  }
  const noNL = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]![0] === '\\';
  const lastPlusNoNL = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]![0] === '\\';
  sec.hunks.push({ a, o, n, noNL, lastPlusNoNL });
  return j;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const newSection = (gitOld?: string, gitNew?: string): Section => {
    const s: Section = {
      pairOld: undefined,
      pairNew: undefined,
      renFrom: undefined,
      renTo: undefined,
      gitOld,
      gitNew,
      create: false,
      del: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isDiffGitLine(line)) {
      const [o, n] = parseDiffGit(line, i + 1);
      newSection(o, n);
      i++;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = newSection();
        s.pairOld = headerPath(line);
        s.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        inHeader = false;
        i = parseHunk(lines, i + 1, cur!, Number(m[1]));
        continue;
      }
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // Between hunks of the current section.
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      i = parseHunk(lines, i + 1, cur!, Number(m[1]));
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = newSection();
      s.pairOld = headerPath(line);
      s.pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text; throws Fail('no-match', path) when a hunk finds nothing. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  const lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const wasAtEnd = at === lines.length;
      const ins = h.n.map((e) => e.text);
      lines.splice(at, 0, ...ins);
      if (wasAtEnd && ins.length > 0) final = !h.noNL;
      d += h.n.length;
      continue;
    }
    const found = findTier(lines, h.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const atEnd = pos + h.o.length === lines.length;
    const rep = buildReplacement(h.n, lines, pos, h.o, found.tier);
    lines.splice(pos, h.o.length, ...rep);
    if (atEnd) final = !h.noNL;
    d += h.n.length - h.o.length;
  }
  return joinFile(lines, f.br, final);
}

function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renFrom !== undefined ? sec.renFrom : sec.gitOld;
    const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renTo !== undefined ? sec.renTo : sec.gitNew;
    return (tree: Tree) => {
      const isCreate = sec.create || oldPath === null;
      const isDelete = !isCreate && (sec.del || newPath === null);
      for (const p of [oldPath, newPath]) {
        if (p !== null && p !== undefined && !safe(p)) throw new Fail('unsafe', p);
      }
      if (isCreate) {
        if (newPath === null || newPath === undefined) return;
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus: string[] = [];
        let noNL = false;
        for (const h of sec.hunks) {
          let hHasPlus = false;
          for (const e of h.n) {
            if (e.ctx === -1) {
              plus.push(e.text);
              hHasPlus = true;
            }
          }
          if (hHasPlus) noNL = h.lastPlusNoNL;
        }
        tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
        return;
      }
      if (oldPath === null || oldPath === undefined) return;
      if (isDelete) {
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      if (newPath !== null && newPath !== undefined && newPath !== oldPath) {
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out = applyHunks(cur, sec.hunks, strict, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        moves.push([oldPath, newPath]);
        return;
      }
      tree.now.set(oldPath, applyHunks(cur, sec.hunks, strict, oldPath));
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let sep = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep === -1) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end === -1) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = splitFile(cur);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length !== 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const rep = buildReplacement(
        newLines.map((t) => ({ text: t, ctx: -1 })),
        f.lines,
        pos,
        oldLines,
        found.tier,
      );
      f.lines.splice(pos, oldLines.length, ...rep);
      tree.now.set(p, joinFile(f.lines, f.br, f.final));
    });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

const ADD_PREFIX = '*** Add File: ';
const DELETE_PREFIX = '*** Delete File: ';
const UPDATE_PREFIX = '*** Update File: ';
const MOVE_TO_PREFIX = '*** Move to: ';

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function isV4aSectionStart(line: string): boolean {
  return line.startsWith(ADD_PREFIX) || line.startsWith(DELETE_PREFIX) || line.startsWith(UPDATE_PREFIX);
}

function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith(ADD_PREFIX) || line.startsWith(DELETE_PREFIX) || line.startsWith(UPDATE_PREFIX)) {
      const kind = line.startsWith(ADD_PREFIX) ? 'add' : line.startsWith(DELETE_PREFIX) ? 'delete' : 'update';
      const prefix = kind === 'add' ? ADD_PREFIX : kind === 'delete' ? DELETE_PREFIX : UPDATE_PREFIX;
      const path = line.slice(prefix.length).trim();
      const startLine = i + 1;
      // Collect the section's raw lines, then drop blank lines at its end.
      const raw: { idx: number; line: string }[] = [];
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) {
        raw.push({ idx: j, line: lines[j]! });
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
      if (kind === 'add') {
        const fileLines: string[] = [];
        for (const r of raw) {
          if (r.line.startsWith('+')) fileLines.push(r.line.slice(1));
          else if (r.line === '') fileLines.push('');
          else throw new Exit2(`error: parse ${r.idx + 1}`);
        }
        const p = path;
        edits.push((tree: Tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
        });
      } else if (kind === 'delete') {
        if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
        const p = path;
        edits.push((tree: Tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.now.set(p, null);
        });
      } else {
        let moveTo: string | null = null;
        let k = 0;
        if (raw.length > 0 && raw[0]!.line.startsWith(MOVE_TO_PREFIX)) {
          moveTo = raw[0]!.line.slice(MOVE_TO_PREFIX.length).trim();
          k = 1;
        }
        const chunks: V4aChunk[] = [];
        let curChunk: V4aChunk | null = null;
        let afterEof = false;
        for (; k < raw.length; k++) {
          const r = raw[k]!;
          const l = r.line;
          if (l.startsWith(MOVE_TO_PREFIX)) throw new Exit2(`error: parse ${r.idx + 1}`);
          if (l.startsWith('@@')) {
            if (curChunk !== null) chunks.push(curChunk);
            curChunk = { anchor: l.slice(2).trim(), body: [], eof: false };
            afterEof = false;
            continue;
          }
          if (l === '*** End of File') {
            // Exact: only Begin Patch and End Patch are compared trimmed (section 8); a body line
            // ` *** End of File` is a context line whose text is `*** End of File`, not this marker.
            if (curChunk === null) throw new Exit2(`error: parse ${r.idx + 1}`);
            curChunk.eof = true;
            chunks.push(curChunk);
            curChunk = null;
            afterEof = true;
            continue;
          }
          if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
            if (afterEof) throw new Exit2(`error: parse ${r.idx + 1}`);
            if (curChunk === null) curChunk = { anchor: null, body: [], eof: false };
            curChunk.body.push(l);
            continue;
          }
          throw new Exit2(`error: parse ${r.idx + 1}`);
        }
        if (curChunk !== null) chunks.push(curChunk);
        if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
        const p = path;
        const mt = moveTo;
        const chs = chunks;
        edits.push((tree: Tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
          const cur = tree.get(p);
          if (cur === null) throw new Fail('missing', p);
          if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
          const f = splitFile(cur);
          const fileLines = f.lines;
          let cursor = 0;
          for (const ch of chs) {
            if (ch.anchor !== null && ch.anchor !== '') {
              let foundIdx = -1;
              for (const tier of tiers(strict)) {
                for (let q = cursor; q < fileLines.length; q++) {
                  if (normLine(fileLines[q]!, tier) === normLine(ch.anchor, tier)) {
                    foundIdx = q;
                    break;
                  }
                }
                if (foundIdx >= 0) break;
              }
              if (foundIdx < 0) throw new Fail('no-match', p);
              cursor = foundIdx + 1;
            }
            const o: string[] = [];
            const n: NLine[] = [];
            for (const bl of ch.body) {
              if (bl === '' || bl[0] === ' ') {
                const text = bl === '' ? '' : bl.slice(1);
                o.push(text);
                n.push({ text, ctx: o.length - 1 });
              } else if (bl[0] === '-') {
                o.push(bl.slice(1));
              } else if (bl[0] === '+') {
                n.push({ text: bl.slice(1), ctx: -1 });
              }
            }
            if (o.length === 0) {
              const at = ch.eof ? fileLines.length : cursor;
              const ins = n.map((e) => e.text);
              fileLines.splice(at, 0, ...ins);
              cursor = at + ins.length;
              continue;
            }
            let found: { tier: number; pos: number } | null = null;
            for (const tier of tiers(strict)) {
              const occ = occurrences(fileLines, o, tier, cursor);
              const valid = ch.eof ? occ.filter((q) => q + o.length === fileLines.length) : occ;
              if (valid.length > 0) {
                found = { tier, pos: valid[0]! };
                break;
              }
            }
            if (found === null) throw new Fail('no-match', p);
            const rep = buildReplacement(n, fileLines, found.pos, o, found.tier);
            fileLines.splice(found.pos, o.length, ...rep);
            cursor = found.pos + rep.length;
          }
          const out = joinFile(fileLines, f.br, f.final);
          if (mt !== null) {
            tree.now.set(p, null);
            tree.now.set(mt, out);
            moves.push([p, mt]);
          } else {
            tree.now.set(p, out);
          }
        });
      }
      i = j;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const nowState = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) === null || nowState(oldP) !== null) continue;
    if (tree.original(newP) !== null || nowState(newP) === null) continue;
    if (usedOld.has(oldP) || usedNew.has(newP)) continue;
    usedOld.add(oldP);
    usedNew.add(newP);
    rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
  }
  for (const p of changed) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    const sortedChanged = [...changed].sort(byteOrder);
    for (const p of sortedChanged) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of sortedChanged) {
      const now = tree.now.get(p)!;
      if (now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.text);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
