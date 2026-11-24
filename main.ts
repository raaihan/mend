// mend: one command-line tool that applies AI-written edits in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool-call edits)
// to a tree of text files, atomically.
//
// Implemented from SPEC.md version 1 (the kit starter's specification), written
// from the spec alone. Node 22 and its standard library only; deterministic.
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// When MAKEFUN_ENV_URL is set, the run is handed to runner.ts (a trial).

import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------- helpers

function isBlank(s: string): boolean {
  return /^\s*$/.test(s);
}

// Trailing whitespace (spaces and tabs; patch lines already lost one \r).
function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.trim();
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function stripTrailingWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripEdgeWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// Patch lines (SPEC section 3): split at \n, one trailing \r removed per line,
// no empty piece after a final \n. Line numbers count these from 1.
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

// ------------------------------------------------------------ file model

interface FileState {
  lines: string[];
  eol: '\r\n' | '\n';
  ends: boolean; // ends with a line break
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], eol: '\n', ends: false };
  const i = text.indexOf('\n');
  const eol: '\r\n' | '\n' = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  const ends = parts.length > 0 && parts[parts.length - 1] === '';
  if (ends) parts.pop();
  return { lines: parts, eol, ends };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.ends ? f.eol : '');
}

type Tree = Map<string, string>; // path -> raw text

function readTree(dir: string): Tree {
  const out: Tree = new Map();
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        try {
          out.set(relative(dir, p).split(sep).join('/'), readFileSync(p, 'utf8'));
        } catch {
          // unreadable file: leave it out of the tree
        }
      }
    }
  };
  walk(dir);
  return out;
}

function writeTree(orig: Tree, tree: Tree): void {
  // Deletes first, so a file replaced by a directory (or the reverse) works.
  for (const p of orig.keys()) {
    if (!tree.has(p)) {
      try {
        unlinkSync(join(process.cwd(), ...p.split('/')));
      } catch {
        // already gone or not a file; nothing to do
      }
    }
  }
  for (const [p, text] of tree) {
    if (!orig.has(p) || orig.get(p) !== text) {
      const full = join(process.cwd(), ...p.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, 'utf8');
    }
  }
}

// A path is safe when it is not empty, does not start with /, holds no \,
// and none of its /-separated segments is empty, . or .. (SPEC section 3).
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ------------------------------------------------------- line matching

// Tier key for one line (SPEC section 5).
function lineKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return stripTrailingWs(line);
  return stripEdgeWs(line);
}

// Every 0-based position where O occurs in lines at the given tier.
function findOccurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < o.length; j++) {
      if (lineKey(lines[i + j], tier) !== lineKey(o[j], tier)) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

// First tier (0..2, or 0 only when strict) at which O occurs at least once.
function firstTier(lines: string[], o: string[], strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (findOccurrences(lines, o, t).length > 0) return t;
  }
  return -1;
}

// First tier at which a single line occurs at or after `from`.
function firstTierFrom(lines: string[], from: number, anchor: string, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = from; i < lines.length; i++) {
      if (lineKey(lines[i], t) === lineKey(anchor, t)) return t;
    }
  }
  return -1;
}

function findSingleFrom(lines: string[], from: number, anchor: string, tier: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lineKey(lines[i], tier) === lineKey(anchor, tier)) return i;
  }
  return -1;
}

// Build the replacement lines for an occurrence of O at position i.
// ctxMap[k] is the O index of N[k] when it is a context line, else -1.
// A context line is written as the file's own matched line, never the patch's.
// At tier 2 every other line of N is re-indented (SPEC section 5).
function buildReplacement(
  fileLines: string[],
  i: number,
  o: string[],
  nLines: string[],
  ctxMap: number[],
  tier: number,
): string[] {
  const out: string[] = [];
  const f = tier === 2 && o.length > 0 ? leadingWs(fileLines[i]) : '';
  const p = tier === 2 && o.length > 0 ? leadingWs(o[0]) : '';
  for (let k = 0; k < nLines.length; k++) {
    if (ctxMap[k] >= 0) {
      out.push(fileLines[i + ctxMap[k]]);
    } else {
      let line = nLines[k];
      if (tier === 2 && line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(p)) {
        line = f + line.slice(p.length);
      }
      out.push(line);
    }
  }
  return out;
}

// Split ops into O lines, N lines and the context map shared by sections 6-8.
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNl: boolean; // a \ line follows this body line
}

function splitOps(ops: Op[]): { o: string[]; nLines: string[]; ctxMap: number[] } {
  const o: string[] = [];
  const nLines: string[] = [];
  const ctxMap: number[] = [];
  for (const op of ops) {
    if (op.kind === 'ctx') {
      ctxMap.push(o.length);
      o.push(op.text);
      nLines.push(op.text);
    } else if (op.kind === 'del') {
      o.push(op.text);
    } else {
      ctxMap.push(-1);
      nLines.push(op.text);
    }
  }
  return { o, nLines, ctxMap };
}

// Whether a \ line follows the hunk/chunk's last context or + line.
function lastCtxOrAddNoNl(ops: Op[]): boolean {
  for (let j = ops.length - 1; j >= 0; j--) {
    if (ops[j].kind === 'ctx' || ops[j].kind === 'add') return ops[j].noNl;
  }
  return false;
}

// ------------------------------------------------------------------ edits

interface EditResult {
  ok: boolean;
  code?: string;
  path?: string;
  move?: [string, string];
}

interface Edit {
  apply(tree: Tree, strict: boolean): EditResult;
}

type ParseOutcome = { edits: Edit[] } | { parseError: number };

function fail(code: string, path: string): EditResult {
  return { ok: false, code, path };
}

// Apply a list of hunks to a file's state, in order (SPEC section 6).
function applyHunks(
  f: FileState,
  hunks: Array<{ a: number; ops: Op[] }>,
  strict: boolean,
): { ok: true; file: FileState } | { ok: false; code: string } {
  let lines = [...f.lines];
  let ends = f.ends;
  let d = 0;
  for (const h of hunks) {
    const { o, nLines, ctxMap } = splitOps(h.ops);
    const noNl = lastCtxOrAddNoNl(h.ops);
    if (o.length > 0) {
      const tier = firstTier(lines, o, strict);
      if (tier < 0) return { ok: false, code: 'no-match' };
      const occ = findOccurrences(lines, o, tier);
      const target = h.a - 1 + d;
      let best = occ[0];
      let bestDist = Math.abs(occ[0] - target);
      for (const pos of occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const repl = buildReplacement(lines, best, o, nLines, ctxMap, tier);
      const touchesEnd = best + o.length === lines.length;
      lines = [...lines.slice(0, best), ...repl, ...lines.slice(best + o.length)];
      if (touchesEnd) ends = !noNl;
      d += nLines.length - o.length;
    } else {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      const repl = buildReplacement(lines, pos, o, nLines, ctxMap, 0);
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos)];
      if (atEnd) ends = !noNl;
      d += nLines.length;
    }
  }
  return { ok: true, file: { lines, eol: f.eol, ends } };
}

// ------------------------------------------------------------ invocation

interface CliArgs {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): CliArgs | null {
  let format = 'auto';
  let formatSet = false;
  let check = false;
  let checkSet = false;
  let strict = false;
  let strictSet = false;
  const positional: string[] = [];
  let noMoreOptions = false;
  for (const a of argv) {
    if (!noMoreOptions && a === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (checkSet) return null;
        checkSet = true;
        check = true;
      } else if (a === '--strict') {
        if (strictSet) return null;
        strictSet = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (formatSet) return null;
        formatSet = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return null;
  return { format, check, strict, patch: positional.length === 1 ? positional[0] : null };
}

// ------------------------------------------------------- format detection

function detectFormat(lines: string[]): string | null {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx < 0) return null;
  if (trimWs(lines[firstIdx]) === '*** Begin Patch') return 'v4a';
  const firstChar = lines[firstIdx].trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (const l of lines) {
    if (trimEndWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ------------------------------------------------------------ unified

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  oldFromDash: boolean; // old path came from a ---/+++ pair (rename must not override it)
  newFromDash: boolean; // new path came from a ---/+++ pair (rename must not override it)
  hunks: Array<{ a: number; ops: Op[] }>;
}

// The path after `--- ` or `+++ `: text after four characters, up to the first
// tab, surrounding spaces removed; /dev/null means no file; a leading a/ or
// b/ is removed.
function parseDiffPath(s: string): string | null {
  const t = s.split('\t')[0].trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

function parseHunkHeader(line: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return { a: parseInt(m[1], 10) };
}

// A hunk body: lines starting with ' ', '-', '+' or '\', or empty lines.
// The body ends at the first other line, at a diff --git line, at a --- line
// followed by a +++ line, or at the end of the patch; empty lines at the end
// of a body are not part of it.
function parseHunkBody(lines: string[], start: number): { ops: Op[]; next: number } {
  const raw: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isDiffGitLine(line)) break;
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
      raw.push(line);
      i++;
    } else {
      break;
    }
  }
  const ops: Op[] = [];
  for (const r of raw) {
    if (r.startsWith('\\')) {
      if (ops.length > 0) ops[ops.length - 1].noNl = true;
      continue;
    }
    if (r === '') ops.push({ kind: 'ctx', text: '', noNl: false });
    else if (r.startsWith(' ')) ops.push({ kind: 'ctx', text: r.slice(1), noNl: false });
    else if (r.startsWith('-')) ops.push({ kind: 'del', text: r.slice(1), noNl: false });
    else if (r.startsWith('+')) ops.push({ kind: 'add', text: r.slice(1), noNl: false });
  }
  while (ops.length > 0 && ops[ops.length - 1].kind === 'ctx' && ops[ops.length - 1].text === '') {
    const removed = ops.pop()!;
    if (removed.noNl) {
      for (let j = ops.length - 1; j >= 0; j--) {
        if (ops[j].kind === 'ctx' || ops[j].kind === 'add') {
          ops[j].noNl = true;
          break;
        }
      }
    }
  }
  return { ops, next: i };
}

function parseUnified(lines: string[]): ParseOutcome {
  const sections: UnifiedSection[] = [];
  let i = 0;
  const n = lines.length;
  let current: UnifiedSection | null = null;
  let inHeader = false;
  while (i < n) {
    const line = lines[i];
    if (isDiffGitLine(line)) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (!m) return { parseError: i + 1 };
      current = { oldPath: m[1], newPath: m[2], creation: false, deletion: false, oldFromDash: false, newFromDash: false, hunks: [] };
      sections.push(current);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (inHeader && current) {
        current.oldPath = parseDiffPath(line.slice(4));
        current.newPath = parseDiffPath(lines[i + 1].slice(4));
        current.oldFromDash = true;
        current.newFromDash = true;
        i += 2;
        continue;
      }
      current = {
        oldPath: parseDiffPath(line.slice(4)),
        newPath: parseDiffPath(lines[i + 1].slice(4)),
        creation: false,
        deletion: false,
        oldFromDash: true,
        newFromDash: true,
        hunks: [],
      };
      sections.push(current);
      inHeader = true;
      i += 2;
      continue;
    }
    if (current && inHeader) {
      if (line.startsWith('--- ')) {
        return { parseError: i + 2 };
      }
      if (line.startsWith('+++ ')) {
        current.newPath = parseDiffPath(line.slice(4));
        current.newFromDash = true;
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!current.oldFromDash) {
          current.oldPath = line.slice('rename from '.length).trim();
        }
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!current.newFromDash) {
          current.newPath = line.slice('rename to '.length).trim();
        }
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        current.creation = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        current.deletion = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const h = parseHunkHeader(line);
        if (!h) return { parseError: i + 1 };
        inHeader = false;
        const body = parseHunkBody(lines, i + 1);
        current.hunks.push({ a: h.a, ops: body.ops });
        i = body.next;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!current) return { parseError: i + 1 };
      const h = parseHunkHeader(line);
      if (!h) return { parseError: i + 1 };
      const body = parseHunkBody(lines, i + 1);
      current.hunks.push({ a: h.a, ops: body.ops });
      i = body.next;
      continue;
    }
    i++;
  }
  const edits: Edit[] = sections.map((sec) => ({
    apply: (tree, strict) => applyUnifiedSection(tree, sec, strict),
  }));
  return { edits };
}

function applyUnifiedSection(tree: Tree, sec: UnifiedSection, strict: boolean): EditResult {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  const isCreation = oldP === null || sec.creation;
  const isDeletion = newP === null || sec.deletion;
  const named: string[] = [];
  if (oldP !== null) named.push(oldP);
  if (newP !== null && newP !== oldP) named.push(newP);
  for (const p of named) {
    if (!isSafePath(p)) return fail('unsafe', p);
  }
  if (isCreation) {
    if (newP === null) return fail('unsafe', '');
    if (tree.has(newP)) return fail('exists', newP);
    const plus: Op[] = [];
    for (const h of sec.hunks) for (const op of h.ops) if (op.kind === 'add') plus.push(op);
    const ends = plus.length === 0 ? false : !plus[plus.length - 1].noNl;
    const f: FileState = { lines: plus.map((p) => p.text), eol: '\n', ends };
    tree.set(newP, serializeFile(f));
    return { ok: true };
  }
  if (isDeletion) {
    if (oldP === null) return fail('unsafe', '');
    if (!tree.has(oldP)) return fail('missing', oldP);
    tree.delete(oldP);
    return { ok: true };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    if (!tree.has(oldP)) return fail('missing', oldP);
    if (tree.has(newP)) return fail('exists', newP);
    const res = applyHunks(parseFile(tree.get(oldP)!), sec.hunks, strict);
    if (!res.ok) return fail(res.code, oldP);
    tree.delete(oldP);
    tree.set(newP, serializeFile(res.file));
    return { ok: true, move: [oldP, newP] };
  }
  const p = oldP ?? newP;
  if (p === null) return fail('unsafe', '');
  if (!tree.has(p)) return fail('missing', p);
  const res = applyHunks(parseFile(tree.get(p)!), sec.hunks, strict);
  if (!res.ok) return fail(res.code, p);
  tree.set(p, serializeFile(res.file));
  return { ok: true };
}

// ------------------------------------------------------- SEARCH/REPLACE

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): ParseOutcome {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (trimEndWs(lines[i]) === '<<<<<<< SEARCH') {
      const s = i;
      let eq = -1;
      for (let j = s + 1; j < n; j++) {
        if (trimEndWs(lines[j]) === '=======') {
          eq = j;
          break;
        }
        if (trimEndWs(lines[j]) === '>>>>>>> REPLACE') break;
      }
      if (eq < 0) return { parseError: s + 1 };
      let end = -1;
      for (let j = eq + 1; j < n; j++) {
        if (trimEndWs(lines[j]) === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
      if (end < 0) return { parseError: s + 1 };
      let path: string | null = null;
      for (let j = s - 1; j > prevEnd; j--) {
        const t = trimWs(lines[j]);
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) return { parseError: s + 1 };
        path = prevPath;
      }
      blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, end) });
      prevPath = path;
      prevEnd = end;
      i = end + 1;
    } else {
      i++;
    }
  }
  return { edits: blocks.map((b) => ({ apply: (tree, strict) => applySrBlock(tree, b, strict) })) };
}

function applySrBlock(tree: Tree, b: SrBlock, strict: boolean): EditResult {
  if (!isSafePath(b.path)) return fail('unsafe', b.path);
  if (b.oldLines.length === 0) {
    if (tree.has(b.path)) return fail('exists', b.path);
    tree.set(b.path, serializeFile({ lines: [...b.newLines], eol: '\n', ends: true }));
    return { ok: true };
  }
  if (!tree.has(b.path)) return fail('missing', b.path);
  const f = parseFile(tree.get(b.path)!);
  const tier = firstTier(f.lines, b.oldLines, strict);
  if (tier < 0) return fail('no-match', b.path);
  const occ = findOccurrences(f.lines, b.oldLines, tier);
  if (occ.length > 1) return fail('ambiguous', b.path);
  const pos = occ[0];
  const ctxMap = b.newLines.map(() => -1);
  const repl = buildReplacement(f.lines, pos, b.oldLines, b.newLines, ctxMap, tier);
  const lines = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + b.oldLines.length)];
  tree.set(b.path, serializeFile({ lines, eol: f.eol, ends: f.ends }));
  return { ok: true };
}

// ------------------------------------------------------------------- V4A

interface V4aChunk {
  anchor: string | null; // null = no anchor
  ops: Op[];
  eof: boolean;
}

type V4aSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

function isSectionHeader(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  );
}

function parseV4a(lines: string[]): ParseOutcome {
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!isBlank(lines[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { parseError: 1 };
  if (trimWs(lines[first]) !== '*** Begin Patch') return { parseError: first + 1 };
  if (trimWs(lines[last]) !== '*** End Patch') return { parseError: n + 1 };
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i])) {
      i++;
      continue;
    }
    const line = lines[i];
    if (line.startsWith('*** Add File: ')) {
      const path = trimWs(line.slice('*** Add File: '.length));
      i++;
      const raw: Array<{ text: string; num: number }> = [];
      while (i < last) {
        const l = lines[i];
        if (isSectionHeader(l)) break;
        if (!isBlank(l) && !l.startsWith('+')) return { parseError: i + 1 };
        raw.push({ text: l, num: i + 1 });
        i++;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();
      sections.push({ kind: 'add', path, lines: raw.map((r) => (r.text === '' ? '' : r.text.slice(1))) });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = trimWs(line.slice('*** Delete File: '.length));
      i++;
      while (i < last) {
        const l = lines[i];
        if (isSectionHeader(l)) break;
        if (!isBlank(l)) return { parseError: i + 1 };
        i++;
      }
      sections.push({ kind: 'delete', path });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = trimWs(line.slice('*** Update File: '.length));
      const headerLine = i + 1;
      i++;
      const raw: Array<{ text: string; num: number }> = [];
      while (i < last) {
        const l = lines[i];
        if (isSectionHeader(l)) break;
        raw.push({ text: l, num: i + 1 });
        i++;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();
      let idx = 0;
      let moveTo: string | null = null;
      let probe = 0;
      while (probe < raw.length && isBlank(raw[probe].text)) probe++;
      if (probe < raw.length && raw[probe].text.startsWith('*** Move to: ')) {
        moveTo = trimWs(raw[probe].text.slice('*** Move to: '.length));
        idx = probe + 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const flush = (): void => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; idx < raw.length; idx++) {
        const l = raw[idx].text;
        const num = raw[idx].num;
        if (l.startsWith('@@')) {
          flush();
          const anchor = trimWs(l.slice(2));
          cur = { anchor: anchor === '' ? null : anchor, ops: [], eof: false };
          continue;
        }
        if (trimWs(l) === '*** End of File') {
          if (!cur) cur = { anchor: null, ops: [], eof: false };
          cur.eof = true;
          flush();
          continue;
        }
        if (l.startsWith('*** Move to: ')) {
          return { parseError: num };
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (!cur) cur = { anchor: null, ops: [], eof: false };
          if (l === '') cur.ops.push({ kind: 'ctx', text: '', noNl: false });
          else if (l.startsWith(' ')) cur.ops.push({ kind: 'ctx', text: l.slice(1), noNl: false });
          else if (l.startsWith('-')) cur.ops.push({ kind: 'del', text: l.slice(1), noNl: false });
          else cur.ops.push({ kind: 'add', text: l.slice(1), noNl: false });
          continue;
        }
        return { parseError: num };
      }
      flush();
      if (chunks.length === 0 && moveTo === null) return { parseError: headerLine };
      sections.push({ kind: 'update', path, moveTo, chunks });
      continue;
    }
    return { parseError: i + 1 };
  }
  const edits: Edit[] = sections.map((sec) => ({
    apply: (tree, strict) => applyV4aSection(tree, sec, strict),
  }));
  return { edits };
}

function applyV4aSection(tree: Tree, sec: V4aSection, strict: boolean): EditResult {
  if (!isSafePath(sec.path)) return fail('unsafe', sec.path);
  if (sec.kind === 'add') {
    if (tree.has(sec.path)) return fail('exists', sec.path);
    tree.set(sec.path, serializeFile({ lines: [...sec.lines], eol: '\n', ends: true }));
    return { ok: true };
  }
  if (sec.kind === 'delete') {
    if (!tree.has(sec.path)) return fail('missing', sec.path);
    tree.delete(sec.path);
    return { ok: true };
  }
  if (sec.moveTo !== null && !isSafePath(sec.moveTo)) return fail('unsafe', sec.moveTo);
  if (!tree.has(sec.path)) return fail('missing', sec.path);
  if (sec.moveTo !== null && tree.has(sec.moveTo)) return fail('exists', sec.moveTo);
  const f = parseFile(tree.get(sec.path)!);
  let lines = [...f.lines];
  let cursor = 0;
  for (const ch of sec.chunks) {
    if (ch.anchor !== null) {
      const tier = firstTierFrom(lines, cursor, ch.anchor, strict);
      if (tier < 0) return fail('no-match', sec.path);
      const idx = findSingleFrom(lines, cursor, ch.anchor, tier);
      if (idx < 0) return fail('no-match', sec.path);
      cursor = idx + 1;
    }
    const { o, nLines, ctxMap } = splitOps(ch.ops);
    if (o.length === 0) {
      const pos = ch.eof ? lines.length : cursor;
      const repl = buildReplacement(lines, pos, o, nLines, ctxMap, 0);
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos)];
      cursor = pos + repl.length;
    } else {
      let tier = -1;
      let occ: number[] = [];
      const maxT = strict ? 0 : 2;
      for (let t = 0; t <= maxT; t++) {
        const all = findOccurrences(lines, o, t).filter((p) => p >= cursor);
        if (all.length > 0) {
          tier = t;
          occ = all;
          break;
        }
      }
      if (tier < 0) return fail('no-match', sec.path);
      let pos = occ[0];
      if (ch.eof) {
        const eofOcc = occ.filter((p) => p + o.length === lines.length);
        if (eofOcc.length === 0) return fail('no-match', sec.path);
        pos = eofOcc[0];
      }
      const repl = buildReplacement(lines, pos, o, nLines, ctxMap, tier);
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + o.length)];
      cursor = pos + repl.length;
    }
  }
  const result = serializeFile({ lines, eol: f.eol, ends: f.ends });
  if (sec.moveTo !== null) {
    tree.delete(sec.path);
    tree.set(sec.moveTo, result);
    return { ok: true, move: [sec.path, sec.moveTo] };
  }
  tree.set(sec.path, result);
  return { ok: true };
}

// ------------------------------------------------------------------ JSON

function validateJsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const fileText = o.file_text;
    return { apply: (tree) => applyJsonCreate(tree, path, fileText) };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = typeof o.new_str === 'string' ? o.new_str : '';
    return { apply: (tree) => applyJsonStrReplace(tree, path, oldStr, newStr) };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const insertLine = o.insert_line;
    const newStr = o.new_str;
    return { apply: (tree) => applyJsonInsert(tree, path, insertLine, newStr) };
  }
  return null;
}

function parseJson(lines: string[], rawText: string): ParseOutcome {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) return { edits: [] };
  if (lines[first].trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(rawText);
    } catch {
      return { parseError: first + 1 };
    }
    if (!Array.isArray(arr)) return { parseError: first + 1 };
    const edits: Edit[] = [];
    for (const el of arr) {
      const e = validateJsonEdit(el);
      if (!e) return { parseError: first + 1 };
      edits.push(e);
    }
    return { edits };
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      return { parseError: i + 1 };
    }
    const e = validateJsonEdit(obj);
    if (!e) return { parseError: i + 1 };
    edits.push(e);
  }
  return { edits };
}

function applyJsonCreate(tree: Tree, path: string, fileText: string): EditResult {
  if (!isSafePath(path)) return fail('unsafe', path);
  if (tree.has(path)) return fail('exists', path);
  tree.set(path, fileText);
  return { ok: true };
}

function applyJsonStrReplace(tree: Tree, path: string, oldStr: string, newStr: string): EditResult {
  if (!isSafePath(path)) return fail('unsafe', path);
  if (!tree.has(path)) return fail('missing', path);
  const raw = tree.get(path)!;
  const f = parseFile(raw);
  let text = raw;
  let oldS = oldStr;
  let newS = newStr;
  if (f.eol === '\r\n') {
    text = raw.replace(/\r\n/g, '\n');
    oldS = oldStr.replace(/\r\n/g, '\n');
    newS = newStr.replace(/\r\n/g, '\n');
  }
  let count = 0;
  let idx = -1;
  let from = 0;
  for (;;) {
    const p = text.indexOf(oldS, from);
    if (p < 0) break;
    count++;
    if (count === 1) idx = p;
    from = p + 1;
  }
  if (count === 0) return fail('no-match', path);
  if (count > 1) return fail('ambiguous', path);
  const replaced = text.slice(0, idx) + newS + text.slice(idx + oldS.length);
  tree.set(path, f.eol === '\r\n' ? replaced.replace(/\n/g, '\r\n') : replaced);
  return { ok: true };
}

function applyJsonInsert(tree: Tree, path: string, insertLine: number, newStr: string): EditResult {
  if (!isSafePath(path)) return fail('unsafe', path);
  if (!tree.has(path)) return fail('missing', path);
  const f = parseFile(tree.get(path)!);
  if (insertLine < 0 || insertLine > f.lines.length) return fail('no-match', path);
  const newLines = splitPatchLines(newStr);
  const lines = [...f.lines.slice(0, insertLine), ...newLines, ...f.lines.slice(insertLine)];
  tree.set(path, serializeFile({ lines, eol: f.eol, ends: f.ends }));
  return { ok: true };
}

// ------------------------------------------------------------------- main

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stdout.write('error: usage\n');
    process.exitCode = 2;
    return;
  }
  let patchText: string;
  if (args.patch === null || args.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(args.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }
  const lines = splitPatchLines(patchText);
  const format = args.format === 'auto' ? detectFormat(lines) : args.format;
  if (format === null) {
    process.stdout.write('error: format\n');
    process.exitCode = 2;
    return;
  }
  let parsed: ParseOutcome;
  if (format === 'unified') parsed = parseUnified(lines);
  else if (format === 'search-replace') parsed = parseSearchReplace(lines);
  else if (format === 'v4a') parsed = parseV4a(lines);
  else parsed = parseJson(lines, patchText);
  if ('parseError' in parsed) {
    process.stdout.write(`error: parse ${parsed.parseError}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.edits.length === 0) {
    process.stdout.write('error: parse 1\n');
    process.exitCode = 2;
    return;
  }
  const orig = readTree(process.cwd());
  let tree: Tree = new Map(orig);
  const failures: Array<{ code: string; path: string }> = [];
  const moves: Array<[string, string]> = [];
  for (const e of parsed.edits) {
    const work: Tree = new Map(tree);
    const res = e.apply(work, args.strict);
    if (res.ok) {
      tree = work;
      if (res.move) moves.push(res.move);
    } else {
      failures.push({ code: res.code!, path: res.path! });
    }
  }
  if (failures.length > 0) {
    const out: string[] = [];
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${parsed.edits.length} edits`);
    process.stdout.write(out.join('\n') + '\n');
    process.exitCode = 1;
    return;
  }
  const changes: Array<{ key: string; line: string }> = [];
  const suppressedD = new Set<string>();
  const suppressedA = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (orig.has(oldP) && !tree.has(oldP) && !orig.has(newP) && tree.has(newP)) {
      changes.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressedD.add(oldP);
      suppressedA.add(newP);
    }
  }
  for (const p of new Set([...orig.keys(), ...tree.keys()])) {
    const inOrig = orig.has(p);
    const inTree = tree.has(p);
    if (inOrig && !inTree && !suppressedD.has(p)) {
      changes.push({ key: p, line: `D ${p}` });
    } else if (!inOrig && inTree && !suppressedA.has(p)) {
      changes.push({ key: p, line: `A ${p}` });
    } else if (inOrig && inTree && orig.get(p) !== tree.get(p)) {
      changes.push({ key: p, line: `M ${p}` });
    }
  }
  changes.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const out: string[] = changes.map((c) => c.line);
  const n = changes.length;
  out.push(n === 1 ? 'ok: 1 file' : `ok: ${n} files`);
  process.stdout.write(out.join('\n') + '\n');
  if (!args.check) writeTree(orig, tree);
  process.exitCode = 0;
}

if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  runCli();
}
