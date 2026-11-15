// github-core-clone-01 — a standalone GitHub-compatible git forge.
// Node 22 stdlib only. No git binary, no dependencies.
// Serves git smart HTTP (v0 + v2), REST v3, GraphQL, and MCP from one process.
//
// Determinism: no wall clock / Math.random in any exported state. REST-created
// commits use a fixed timestamp; issue/PR ordering uses insertion sequence.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const ZERO_OID = '0000000000000000000000000000000000000000';
const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
const FORGE_NAME = 'github-core-clone-forge';
const FORGE_VERSION = '1.0.0';
// Fixed timestamp for every server-created commit, so replays are byte-identical.
const FIXED_EPOCH = 1700000000;
const FIXED_ISO = '2026-01-01T00:00:00Z';

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject { type: ObjType; data: Buffer }

interface Label { name: string; color: string; description: string }
interface IssueComment { id: number; body: string }
interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; comments: IssueComment[]; seq: number;
}
interface PullRequest {
  number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; head: string; base: string; headSha: string; baseSha: string;
  mergeCommitSha: string | null; mergedAt: string | null; seq: number;
}
interface Repo {
  id: number; owner: string; name: string; description: string; private: boolean;
  defaultBranch: string; seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[]; labels: Map<string, Label>; prs: PullRequest[];
  nextIssue: number; nextPr: number; nextComment: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextRepoSeq = 1;
let requestSeq = 0;

const repoKey = (owner: string, name: string): string => `${owner}/${name}`;
function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
function newRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId++, owner, name, description, private: isPrivate,
    defaultBranch: 'main', seq: nextRepoSeq++,
    objects: new Map(), refs: new Map(),
    issues: [], labels: new Map(), prs: [],
    nextIssue: 1, nextPr: 1, nextComment: 1,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

// ---------------------------------------------------------------------------
// Git primitives
// ---------------------------------------------------------------------------

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Encode one pkt-line. `data` must already end with \n when it is a text line. */
function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

function encodePktLines(items: Array<string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) parts.push(pktLine(item));
  return Buffer.concat(parts);
}

/**
 * Decode pkt-lines from a buffer starting at `offset`.
 * Returns the decoded lines and the offset just past the terminating flush
 * (or the end of the buffer when no flush is present).
 * Each line is { kind: 'data', data: Buffer } or { kind: 'flush' | 'delim' | 'response-end' }.
 */
type PktLineResult =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function decodePktLines(buf: Buffer, offset = 0): { lines: PktLineResult[]; next: number } {
  const lines: PktLineResult[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const lenHex = buf.subarray(pos, pos + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) break;
    if (len === 0) { lines.push({ kind: 'flush' }); pos += 4; continue; }
    if (len === 1) { lines.push({ kind: 'delim' }); pos += 4; continue; }
    if (len === 2) { lines.push({ kind: 'response-end' }); pos += 4; continue; }
    if (pos + len > buf.length) break;
    lines.push({ kind: 'data', data: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { lines, next: pos };
}

function decodePktText(buf: Buffer, offset = 0): { lines: string[]; next: number } {
  const { lines, next } = decodePktLines(buf, offset);
  const out: string[] = [];
  for (const line of lines) {
    if (line.kind === 'data') out.push(line.data.toString('utf8'));
    else if (line.kind === 'flush') out.push('\0FLUSH');
    else if (line.kind === 'delim') out.push('\0DELIM');
    else out.push('\0END');
  }
  return { lines: out, next };
}

/** Parse a commit object into its parts. */
interface ParsedCommit { tree: string; parents: string[]; author: string; committer: string; message: string }
function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

function buildCommit(tree: string, parents: string[], message: string): Buffer {
  const ident = `A U Thor <a@u.thor> ${FIXED_EPOCH} +0000`;
  let text = `tree ${tree}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

interface TreeEntry { mode: string; name: string; oid: string }
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.name + (a.mode === '40000' ? '/' : '');
    const bn = b.name + (b.mode === '40000' ? '/' : '');
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseTag(data: Buffer): { object: string; type: ObjType; tag: string; message: string } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const out = { object: '', type: 'commit' as ObjType, tag: '', message: headEnd >= 0 ? text.slice(headEnd + 2) : '' };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
  }
  return out;
}

/** Flatten a tree into path -> {oid, mode}. Returns null when the tree is missing. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): boolean {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return false;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      if (!flattenTree(repo, e.oid, path, out)) return false;
    } else {
      out.set(path, { oid: e.oid, mode: e.mode });
    }
  }
  return true;
}

/** Build a tree object from a flat path map (nested directories created as needed). */
function treeFromFlat(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [path, info] of files) {
      if (prefix && !path.startsWith(prefix + '/')) continue;
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: info.mode, name: rest, oid: info.oid });
      else {
        const dir = rest.slice(0, slash);
        if (!subdirs.has(dir)) subdirs.set(dir, new Map());
        subdirs.get(dir)!.set(path, info);
      }
    }
    for (const [dir, sub] of subdirs) entries.push({ mode: '40000', name: dir, oid: build(prefix ? `${prefix}/${dir}` : dir) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build('');
}

/** All commits reachable from `tip`, newest-first (depth-first, parents after). */
function walkCommits(repo: Repo, tip: string, limit = 10000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i--) stack.push(parents[i]);
  }
  return out;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const stack: string[] = [descendant];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** Best common ancestor of a and b (first common commit walking from b). */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aAncestors = new Set(walkCommits(repo, a));
  const stack: string[] = [b];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (aAncestors.has(oid)) return oid;
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return null;
}

/** Peel an annotated tag to the commit it points at (tags point at commits here). */
function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i++) {
    const obj = getObject(repo, cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pack format (version 2, plain objects; delta resolution on read)
// ---------------------------------------------------------------------------

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return result;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      outLen += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(chunks);
}

const PACK_TYPE_NAMES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Parse a pack. Returns the objects it contains (deltas resolved). */
function readPack(buf: Buffer): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  // Verify the trailer SHA-1 over everything but the last 20 bytes.
  if (buf.length < 32) throw new Error('pack too short');
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const bodySha = sha1Hex(buf.subarray(0, buf.length - 20));
  if (trailer !== bodySha) throw new Error('pack checksum mismatch');
  let pos = 12;
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  for (let i = 0; i < count; i++) {
    const entryStart = pos;
    const first = buf[pos];
    const typeNum = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    pos += 1;
    while (buf[pos - 1] & 0x80) {
      size |= (buf[pos] & 0x7f) << shift;
      shift += 7;
      pos += 1;
    }
    if (typeNum === 6 || typeNum === 7) throw new Error('deltified pack entries are not accepted here');
    const type = PACK_TYPE_NAMES[typeNum];
    if (!type) throw new Error(`unknown pack type ${typeNum}`);
    // Decompress a zlib stream of unknown length (binary search: inflateSync
    // throws on a truncated stream and ignores trailing bytes once complete).
    const { data, next } = inflateOne(buf, pos, size);
    pos = next;
    const oid = hashObject(type, data);
    out.set(oid, { type, data });
    byOffset.set(entryStart, { type, data });
  }
  return out;
}

/** Inflate exactly one zlib stream starting at `pos`; returns the data and the offset just past it. */
function inflateOne(buf: Buffer, pos: number, expectedSize: number): { data: Buffer; next: number } {
  // The predicate "inflateSync succeeds with the expected size" is monotonic in
  // the end offset, so binary-search the smallest end that works.
  let lo = pos + 2;
  let hi = buf.length;
  let found: { data: Buffer; next: number } | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const data = inflateSync(buf.subarray(pos, mid));
      if (data.length === expectedSize) { found = { data, next: mid }; hi = mid - 1; }
      else if (data.length < expectedSize) lo = mid + 1;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (!found) throw new Error('could not inflate pack entry');
  return found;
}

/** Build a pack v2 with plain (undeltified) objects. */
function writePack(objects: Map<string, GitObject>): Buffer {
  const entries: Buffer[] = [];
  const typeNums: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const [oid, obj] of objects) {
    const deflated = deflateSync(obj.data);
    const typeNum = typeNums[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeNum << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    entries.push(Buffer.concat([Buffer.from(headerBytes), deflated]));
  }
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([header, ...entries]);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** All objects reachable from a set of commits (commits + trees + blobs + tags). */
function collectReachable(repo: Repo, tips: string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const commitStack = [...tips];
  const seenCommits = new Set<string>();
  const queueTrees: string[] = [];
  while (commitStack.length > 0) {
    const oid = commitStack.pop()!;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const obj = getObject(repo, oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      out.set(oid, obj);
      const targetObj = getObject(repo, target);
      if (targetObj?.type === 'commit') commitStack.push(target);
      continue;
    }
    if (obj.type !== 'commit') continue;
    out.set(oid, obj);
    queueTrees.push(parseCommit(obj.data).tree);
    for (const p of parseCommit(obj.data).parents) commitStack.push(p);
  }
  const seenTrees = new Set<string>();
  while (queueTrees.length > 0) {
    const treeOid = queueTrees.pop()!;
    if (seenTrees.has(treeOid)) continue;
    seenTrees.add(treeOid);
    const obj = getObject(repo, treeOid);
    if (!obj || obj.type !== 'tree') continue;
    out.set(treeOid, obj);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') queueTrees.push(e.oid);
      else {
        const blob = getObject(repo, e.oid);
        if (blob) out.set(e.oid, blob);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
function b64urlDecode(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}
function globalId(kind: string, ...parts: Array<string | number>): string {
  return b64urlEncode([kind, ...parts].join(':'));
}
function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = b64urlDecode(id);
    const [kind, ...parts] = decoded.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function envToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const token = envToken();
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  if (token === '') return match[1].length > 0;
  return match[1] === token;
}

function nextRequestId(): string {
  requestSeq += 1;
  return requestSeq.toString(16).padStart(12, '0');
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://example.invalid/docs' });
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 1002 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `https://example.invalid/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: globalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ffffff', description: '' };
    }),
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://example.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** Three-way merge of flat file maps. Returns the merged map and whether it conflicts. */
function mergeFlatMaps(
  base: Map<string, { oid: string; mode: string }>,
  head: Map<string, { oid: string; mode: string }>,
  tip: Map<string, { oid: string; mode: string }>,
): { merged: Map<string, { oid: string; mode: string }>; conflict: boolean } {
  const merged = new Map<string, { oid: string; mode: string }>();
  let conflict = false;
  const paths = new Set([...base.keys(), ...head.keys(), ...tip.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const t = tip.get(path);
    const same = (a?: { oid: string; mode: string }, c?: { oid: string; mode: string }): boolean =>
      a?.oid === c?.oid && a?.mode === c?.mode;
    if (same(h, b)) {
      // Head unchanged: take the tip side.
      if (t) merged.set(path, t);
    } else if (same(t, b)) {
      // Tip unchanged: take the head side.
      if (h) merged.set(path, h);
    } else if (same(h, t)) {
      if (h) merged.set(path, h);
    } else {
      conflict = true;
      if (t) merged.set(path, t);
    }
  }
  return { merged, conflict };
}

function prMergeable(repo: Repo, pr: PullRequest): string {
  if (pr.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const base = mergeBase(repo, baseTip, headTip);
  if (!base) return 'UNKNOWN';
  const baseTree = new Map<string, { oid: string; mode: string }>();
  const headTree = new Map<string, { oid: string; mode: string }>();
  const tipTree = new Map<string, { oid: string; mode: string }>();
  const baseCommit = getObject(repo, base);
  const headCommit = getObject(repo, headTip);
  const tipCommit = getObject(repo, baseTip);
  if (!baseCommit || !headCommit || !tipCommit) return 'UNKNOWN';
  flattenTree(repo, parseCommit(baseCommit.data).tree, '', baseTree);
  flattenTree(repo, parseCommit(headCommit.data).tree, '', headTree);
  flattenTree(repo, parseCommit(tipCommit.data).tree, '', tipTree);
  return mergeFlatMaps(baseTree, headTree, tipTree).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: globalId('pr', repo.id, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    mergeable: prMergeable(repo, pr),
    merge_commit_sha: pr.mergeCommitSha,
    merged_at: pr.mergedAt,
    head: { ref: pr.head, sha: pr.headSha, label: `${repo.owner}:${pr.head}` },
    base: { ref: pr.base, sha: pr.baseSha, label: `${repo.owner}:${pr.base}` },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `https://example.invalid/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

/** Count added/removed lines between two texts (multiset line difference). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newLines) {
    const diff = count - (oldLines.get(line) ?? 0);
    if (diff > 0) additions += diff;
  }
  for (const [line, count] of oldLines) {
    const diff = count - (newLines.get(line) ?? 0);
    if (diff > 0) deletions += diff;
  }
  return { additions, deletions };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'commit') return { sha: oid };
  const parsed = parseCommit(obj.data);
  return {
    sha: oid,
    commit: {
      message: parsed.message,
      author: { name: 'A U Thor', email: 'a@u.thor', date: FIXED_ISO },
      committer: { name: 'A U Thor', email: 'a@u.thor', date: FIXED_ISO },
      tree: { sha: parsed.tree },
    },
    parents: parsed.parents.map((p) => ({ sha: p })),
    url: `https://example.invalid/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function paginationLinks(req: IncomingMessage, basePath: string, perPage: number, page: number, total: number): string {
  const host = req.headers.host ?? 'localhost';
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (p: number): string => `http://${host}${basePath}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(lastPage)}>; rel="last"`);
  return parts.join(', ');
}

function resolveBranchRef(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function branchTreeFiles(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> | null {
  const tip = resolveBranchRef(repo, branch);
  if (!tip) return null;
  const obj = getObject(repo, tip);
  if (!obj || obj.type !== 'commit') return null;
  const files = new Map<string, { oid: string; mode: string }>();
  if (!flattenTree(repo, parseCommit(obj.data).tree, '', files)) return null;
  return files;
}

/** Create a commit on `branch` from a flat file map and move the branch ref. */
function commitFiles(repo: Repo, branch: string, files: Map<string, { oid: string; mode: string }>, message: string): string {
  const treeOid = treeFromFlat(repo, files);
  const tip = resolveBranchRef(repo, branch);
  const parents = tip ? [tip] : [];
  const commitOid = storeObject(repo, 'commit', buildCommit(treeOid, parents, message));
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const segments = path.split('/').filter((s) => s.length > 0);

  // GET /api/v3/ — API root.
  if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    sendJson(res, 200, {
      current_user_url: 'https://example.invalid/api/v3/user',
      rate_limit_url: 'https://example.invalid/api/v3/rate_limit',
      repository_url: 'https://example.invalid/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  // GET /api/v3/meta
  if (method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
    return true;
  }
  // GET /api/v3/user
  if (method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return true;
  }
  // /api/v3/user/repos
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      const mine = [...repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.seq - b.seq);
      const slice = mine.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, slice.map(repoJson), { link: paginationLinks(req, '/api/v3/user/repos', perPage, page, mine.length) });
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
      const name = asString(parsed.value.name);
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) { sendError(res, 422, 'Validation Failed'); return true; }
      if (findRepo(VIEWER.login, name)) {
        sendJson(res, 422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
        return true;
      }
      const repo = newRepo(VIEWER.login, name, asString(parsed.value.description) ?? '', asBoolean(parsed.value.private) ?? false);
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    return false;
  }

  // /api/v3/repos/:owner/:name[/...]
  if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = decodeURIComponent(segments[3]);
    const name = decodeURIComponent(segments[4]);
    const rest = segments.slice(5);
    const repo = findRepo(owner, name);
    if (!repo) { sendError(res, 404, 'Not Found'); return true; }

    // GET/PATCH/DELETE /repos/:owner/:name
    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
        const description = asString(parsed.value.description);
        if (description !== undefined) repo.description = description;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return true;
      }
      return false;
    }

    // POST /repos/:owner/:name/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (!ref || !sha || !/^refs\/(heads|tags)\//.test(ref)) { sendError(res, 422, 'Validation Failed'); return true; }
      if (repo.refs.has(ref)) { sendError(res, 422, 'Reference already exists'); return true; }
      const obj = getObject(repo, sha);
      if (!obj) { sendError(res, 422, 'Validation Failed'); return true; }
      if (ref.startsWith('refs/heads/') && obj.type !== 'commit') { sendError(res, 422, 'Validation Failed'); return true; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: obj.type }, url: `https://example.invalid/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
      return true;
    }

    // GET /repos/:owner/:name/git/refs/heads/:branch  (and singular /git/ref/heads/:branch)
    if ((rest.length === 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && method === 'GET') ||
        (rest.length === 4 && rest[0] === 'git' && rest[1] === 'ref' && rest[2] === 'heads' && method === 'GET')) {
      const branch = decodeURIComponent(rest[3]);
      const tip = resolveBranchRef(repo, branch);
      if (!tip) { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' }, url: `https://example.invalid/api/v3/repos/${owner}/${name}/git/refs/heads/${branch}` });
      return true;
    }

    // GET /repos/:owner/:name/branches[/:branch]
    if (rest[0] === 'branches' && method === 'GET') {
      if (rest.length === 1) {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`)! }, protected: false }));
        sendJson(res, 200, list);
        return true;
      }
      if (rest.length === 2) {
        const branch = decodeURIComponent(rest[1]);
        const tip = resolveBranchRef(repo, branch);
        if (!tip) { sendError(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
        return true;
      }
      return false;
    }

    // GET /repos/:owner/:name/commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const shaParam = url.searchParams.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        tip = resolveBranchRef(repo, shaParam) ?? (getObject(repo, shaParam)?.type === 'commit' ? shaParam : undefined);
        if (!tip) { sendError(res, 404, 'Not Found'); return true; }
      } else {
        tip = resolveBranchRef(repo, repo.defaultBranch);
        if (!tip) { sendJson(res, 200, []); return true; }
      }
      sendJson(res, 200, walkCommits(repo, tip).map((oid) => commitJson(repo, oid)));
      return true;
    }

    // /repos/:owner/:name/contents/:path...
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      // GET reads the ref from the query string; PUT/DELETE take `branch` from the body.
      const branchFromQuery = url.searchParams.get('ref') ?? repo.defaultBranch;
      if (method === 'GET') {
        const branch = branchFromQuery;
        const files = branchTreeFiles(repo, branch);
        if (!files) { sendError(res, 404, 'Not Found'); return true; }
        if (contentPath === '') {
          // Root listing.
          const entries = new Map<string, { type: string; name: string; path: string; sha: string; size: number }>();
          for (const [path, info] of files) {
            const slash = path.indexOf('/');
            if (slash < 0) {
              const blob = getObject(repo, info.oid);
              entries.set(path, { type: 'file', name: path, path, sha: info.oid, size: blob?.data.length ?? 0 });
            } else {
              const dir = path.slice(0, slash);
              if (!entries.has(dir)) entries.set(dir, { type: 'dir', name: dir, path: dir, sha: '', size: 0 });
            }
          }
          sendJson(res, 200, [...entries.values()].map((e) => ({ ...e, url: `https://example.invalid/api/v3/repos/${owner}/${name}/contents/${e.path}` })));
          return true;
        }
        const file = files.get(contentPath);
        if (file) {
          const blob = getObject(repo, file.oid);
          sendJson(res, 200, {
            type: 'file', name: contentPath.split('/').pop(), path: contentPath, sha: file.oid,
            size: blob?.data.length ?? 0, encoding: 'base64',
            content: blob ? blob.data.toString('base64') : '',
            url: `https://example.invalid/api/v3/repos/${owner}/${name}/contents/${contentPath}`,
          });
          return true;
        }
        // Directory listing?
        const prefix = contentPath + '/';
        const entries = new Map<string, { type: string; name: string; path: string; sha: string; size: number }>();
        for (const [path, info] of files) {
          if (!path.startsWith(prefix)) continue;
          const restPath = path.slice(prefix.length);
          const slash = restPath.indexOf('/');
          if (slash < 0) {
            const blob = getObject(repo, info.oid);
            entries.set(restPath, { type: 'file', name: restPath, path, sha: info.oid, size: blob?.data.length ?? 0 });
          } else {
            const dir = restPath.slice(0, slash);
            if (!entries.has(dir)) entries.set(dir, { type: 'dir', name: dir, path: contentPath + '/' + dir, sha: '', size: 0 });
          }
        }
        if (entries.size > 0) {
          sendJson(res, 200, [...entries.values()].map((e) => ({ ...e, url: `https://example.invalid/api/v3/repos/${owner}/${name}/contents/${e.path}` })));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
        const branch = asString(parsed.value.branch) ?? branchFromQuery;
        const message = asString(parsed.value.message) ?? `Update ${contentPath}`;
        const contentB64 = asString(parsed.value.content);
        const sha = asString(parsed.value.sha);
        if (contentB64 === undefined) { sendError(res, 422, 'Validation Failed'); return true; }
        const content = Buffer.from(contentB64, 'base64');
        const files = branchTreeFiles(repo, branch);
        const existing = files?.get(contentPath);
        if (sha) {
          if (!existing || existing.oid !== sha) { sendError(res, 409, 'Conflict'); return true; }
        } else if (existing) {
          sendError(res, 409, 'Conflict');
          return true;
        }
        const newFiles = new Map(files ?? []);
        const blobOid = storeObject(repo, 'blob', content);
        newFiles.set(contentPath, { oid: blobOid, mode: '100644' });
        const commitOid = commitFiles(repo, branch, newFiles, message);
        sendJson(res, existing ? 200 : 201, {
          content: { type: 'file', name: contentPath.split('/').pop(), path: contentPath, sha: blobOid, size: content.length, encoding: 'base64', content: contentB64 },
          commit: { sha: commitOid, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
        const branch = asString(parsed.value.branch) ?? branchFromQuery;
        const message = asString(parsed.value.message) ?? `Delete ${contentPath}`;
        const sha = asString(parsed.value.sha);
        const files = branchTreeFiles(repo, branch);
        const existing = files?.get(contentPath);
        if (!existing || (sha && existing.oid !== sha)) { sendError(res, 409, 'Conflict'); return true; }
        const newFiles = new Map(files);
        newFiles.delete(contentPath);
        const commitOid = commitFiles(repo, branch, newFiles, message);
        sendJson(res, 200, { content: null, commit: { sha: commitOid, message } });
        return true;
      }
      return false;
    }

    // POST /repos/:owner/:name/labels
    if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
      const name = asString(parsed.value.name);
      if (!name) { sendError(res, 422, 'Validation Failed'); return true; }
      if (repo.labels.has(name)) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
        return true;
      }
      const label: Label = {
        name,
        color: (asString(parsed.value.color) ?? 'ffffff').replace(/^#/, ''),
        description: asString(parsed.value.description) ?? '',
      };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(label));
      return true;
    }

    // /repos/:owner/:name/issues[/:n[/comments]]
    if (rest[0] === 'issues') {
      if (rest.length === 1 && method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
        const title = asString(parsed.value.title);
        if (!title) { sendError(res, 422, 'Validation Failed'); return true; }
        const labelNames = Array.isArray(parsed.value.labels) ? (parsed.value.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
        for (const labelName of labelNames) {
          if (!repo.labels.has(labelName)) {
            sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'invalid', field: 'labels' }] });
            return true;
          }
        }
        const issue: Issue = {
          number: repo.nextIssue++, title, body: asString(parsed.value.body) ?? '',
          state: 'open', labels: labelNames, comments: [], seq: repo.issues.length + 1,
        };
        repo.issues.push(issue);
        sendJson(res, 201, issueJson(repo, issue));
        return true;
      }
      if (rest.length === 1 && method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        if (sort === 'created') {
          list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        sendJson(res, 200, list.map((i) => issueJson(repo, i)));
        return true;
      }
      if (rest.length >= 2) {
        const number = Number(rest[1]);
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) { sendError(res, 404, 'Not Found'); return true; }
        if (rest.length === 2 && method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
        if (rest.length === 2 && method === 'PATCH') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
          const state = asString(parsed.value.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = asString(parsed.value.title);
          if (title !== undefined) issue.title = title;
          const bodyText = asString(parsed.value.body);
          if (bodyText !== undefined) issue.body = bodyText;
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (method === 'POST') {
            const parsed = parseJsonBody(body);
            if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
            const commentBody = asString(parsed.value.body);
            if (commentBody === undefined) { sendError(res, 422, 'Validation Failed'); return true; }
            const comment: IssueComment = { id: repo.nextComment++, body: commentBody };
            issue.comments.push(comment);
            sendJson(res, 201, { id: comment.id, body: comment.body, created_at: FIXED_ISO, updated_at: FIXED_ISO });
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: FIXED_ISO, updated_at: FIXED_ISO })));
            return true;
          }
        }
        return false;
      }
      return false;
    }

    // GET /repos/:owner/:name/pulls (list)
    if (rest.length === 1 && rest[0] === 'pulls' && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const list = repo.prs.filter((p) => state === 'all' || p.state === state);
      sendJson(res, 200, [...list].sort((a, b) => b.seq - a.seq).map((p) => prJson(repo, p)));
      return true;
    }

    // POST /repos/:owner/:name/pulls
    if (rest.length === 1 && rest[0] === 'pulls' && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
      const title = asString(parsed.value.title);
      const head = asString(parsed.value.head);
      const base = asString(parsed.value.base);
      if (!title || !head || !base) { sendError(res, 422, 'Validation Failed'); return true; }
      const headSha = resolveBranchRef(repo, head);
      const baseSha = resolveBranchRef(repo, base);
      if (!headSha || !baseSha) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'invalid', field: !headSha ? 'head' : 'base' }] });
        return true;
      }
      const pr: PullRequest = {
        number: repo.nextPr++, title, body: asString(parsed.value.body) ?? '',
        state: 'open', merged: false, head, base, headSha, baseSha,
        mergeCommitSha: null, mergedAt: null, seq: repo.prs.length + 1,
      };
      repo.prs.push(pr);
      sendJson(res, 201, prJson(repo, pr));
      return true;
    }

    // /repos/:owner/:name/pulls/:n[/files|/merge]
    if (rest[0] === 'pulls' && rest.length >= 2) {
      const number = Number(rest[1]);
      const pr = repo.prs.find((p) => p.number === number);
      if (!pr) { sendError(res, 404, 'Not Found'); return true; }
      if (rest.length === 2 && method === 'GET') { sendJson(res, 200, prJson(repo, pr)); return true; }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
        const headTip = repo.refs.get(`refs/heads/${pr.head}`);
        if (!baseTip || !headTip) { sendJson(res, 200, []); return true; }
        const mergeBaseOid = mergeBase(repo, baseTip, headTip) ?? baseTip;
        const baseTree = new Map<string, { oid: string; mode: string }>();
        const headTree = new Map<string, { oid: string; mode: string }>();
        const baseCommit = getObject(repo, mergeBaseOid);
        const headCommit = getObject(repo, headTip);
        if (baseCommit) flattenTree(repo, parseCommit(baseCommit.data).tree, '', baseTree);
        if (headCommit) flattenTree(repo, parseCommit(headCommit.data).tree, '', headTree);
        const files: Array<Record<string, unknown>> = [];
        const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
        for (const path of [...paths].sort()) {
          const b = baseTree.get(path);
          const h = headTree.get(path);
          if (b && h && b.oid === h.oid) continue;
          const oldText = b ? (getObject(repo, b.oid)?.data.toString('utf8') ?? '') : '';
          const newText = h ? (getObject(repo, h.oid)?.data.toString('utf8') ?? '') : '';
          const { additions, deletions } = lineDiff(oldText, newText);
          const status = !b ? 'added' : !h ? 'removed' : 'modified';
          files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
        }
        sendJson(res, 200, files);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pr.state !== 'open') { sendError(res, 405, 'Pull Request is not mergeable'); return true; }
        const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
        const headTip = repo.refs.get(`refs/heads/${pr.head}`);
        if (!baseTip || !headTip) { sendError(res, 405, 'Pull Request is not mergeable'); return true; }
        const mergeBaseOid = mergeBase(repo, baseTip, headTip);
        if (!mergeBaseOid) { sendError(res, 405, 'Pull Request is not mergeable'); return true; }
        const baseTree = new Map<string, { oid: string; mode: string }>();
        const headTree = new Map<string, { oid: string; mode: string }>();
        const tipTree = new Map<string, { oid: string; mode: string }>();
        const baseCommit = getObject(repo, mergeBaseOid);
        const headCommit = getObject(repo, headTip);
        const tipCommit = getObject(repo, baseTip);
        if (!baseCommit || !headCommit || !tipCommit) { sendError(res, 405, 'Pull Request is not mergeable'); return true; }
        flattenTree(repo, parseCommit(baseCommit.data).tree, '', baseTree);
        flattenTree(repo, parseCommit(headCommit.data).tree, '', headTree);
        flattenTree(repo, parseCommit(tipCommit.data).tree, '', tipTree);
        const { merged, conflict } = mergeFlatMaps(baseTree, headTree, tipTree);
        if (conflict) { sendError(res, 405, 'Merge conflict'); return true; }
        const mergedTreeOid = treeFromFlat(repo, merged);
        const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.head}\n\n${pr.title}`;
        const mergeOid = storeObject(repo, 'commit', buildCommit(mergedTreeOid, [baseTip], message));
        repo.refs.set(`refs/heads/${pr.base}`, mergeOid);
        pr.state = 'closed';
        pr.merged = true;
        pr.mergeCommitSha = mergeOid;
        pr.mergedAt = FIXED_ISO;
        sendJson(res, 200, { sha: mergeOid, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      return false;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_PACK_V0_CAPS = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=github-core-clone-forge/1.0 symref=HEAD:refs/heads/main';
const RECEIVE_PACK_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=github-core-clone-forge/1.0 symref=HEAD:refs/heads/main';

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** v0 advertisement for upload-pack or receive-pack. */
function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_PACK_V0_CAPS : RECEIVE_PACK_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refs = sortedRefNames(repo);
  if (refs.length === 0 || !defaultTip) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${defaultTip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      const oid = repo.refs.get(ref)!;
      parts.push(pktLine(`${oid} ${ref}\n`));
      const obj = getObject(repo, oid);
      if (ref.startsWith('refs/tags/') && obj?.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 advertisement for upload-pack. */
function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${FORGE_NAME}/${FORGE_VERSION}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow thin-pack ofs-delta filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

interface LsRefLine { oid: string; name: string; unborn: boolean; symrefTarget?: string; peeled?: string }

function lsRefsResponse(repo: Repo, opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: LsRefLine[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const matches = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  if (matches('HEAD')) {
    if (defaultTip) {
      lines.push({ oid: defaultTip, name: 'HEAD', unborn: false, symrefTarget: opts.symrefs ? `refs/heads/${repo.defaultBranch}` : undefined });
    } else if (opts.unborn) {
      lines.push({ oid: ZERO_OID, name: 'HEAD', unborn: true, symrefTarget: opts.symrefs ? `refs/heads/${repo.defaultBranch}` : undefined });
    }
  }
  for (const ref of sortedRefNames(repo)) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref)!;
    const line: LsRefLine = { oid, name: ref, unborn: false };
    if (opts.symrefs && ref === `refs/heads/${repo.defaultBranch}`) line.symrefTarget = undefined;
    if (opts.peel && ref.startsWith('refs/tags/')) {
      const obj = getObject(repo, oid);
      if (obj?.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled) line.peeled = peeled;
      }
    }
    lines.push(line);
  }
  const parts: Buffer[] = [];
  for (const line of lines) {
    let text: string;
    if (line.unborn) {
      text = `unborn ${line.name}${line.symrefTarget ? ` symref-target:${line.symrefTarget}` : ''}\n`;
    } else {
      text = `${line.oid} ${line.name}${line.symrefTarget ? ` symref-target:${line.symrefTarget}` : ''}${line.peeled ? ` peeled:${line.peeled}` : ''}\n`;
    }
    parts.push(pktLine(text));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Objects for a set of commits (the commits themselves + their trees/blobs, not ancestors). */
function objectsForCommits(repo: Repo, commits: string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const walkTree = (treeOid: string): void => {
    const treeObj = getObject(repo, treeOid);
    if (!treeObj || treeObj.type !== 'tree') return;
    out.set(treeOid, treeObj);
    for (const e of parseTree(treeObj.data)) {
      if (e.mode === '40000') walkTree(e.oid);
      else {
        const blob = getObject(repo, e.oid);
        if (blob) out.set(e.oid, blob);
      }
    }
  };
  for (const oid of commits) {
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    out.set(oid, obj);
    walkTree(parseCommit(obj.data).tree);
  }
  return out;
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

/** Build the pack for a fetch: wants, haves, shallow boundaries, optional depth. */
function computeFetchPack(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | undefined,
): FetchPlan {
  // Held objects: reachable from haves, minus the ancestors of shallow boundaries
  // (the client holds a shallow boundary commit but not its history).
  const held = collectReachable(repo, haves);
  for (const boundary of shallowBoundaries) {
    const obj = getObject(repo, boundary);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      for (const oid of collectReachable(repo, [parent]).keys()) held.delete(oid);
    }
  }
  // Wanted commits: BFS from wants, limited to `depth` generations. A want may be
  // an annotated tag object: include the tag itself and peel to its commit.
  const wanted = new Map<string, number>(); // oid -> generation (1-based)
  const extraObjects = new Map<string, GitObject>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    let cur = want;
    for (let i = 0; i < 10; i++) {
      const obj = getObject(repo, cur);
      if (!obj) break;
      if (obj.type === 'tag') {
        extraObjects.set(cur, obj);
        cur = parseTag(obj.data).object;
        continue;
      }
      if (obj.type === 'commit') { queue.push({ oid: cur, gen: 1 }); break; }
      break;
    }
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (depth !== undefined && gen > depth) continue;
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    wanted.set(oid, gen);
    if (depth === undefined || gen < depth) {
      for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, gen: gen + 1 });
    }
  }
  const newObjects = objectsForCommits(repo, [...wanted.keys()]);
  for (const [oid, obj] of extraObjects) newObjects.set(oid, obj);
  for (const oid of held.keys()) newObjects.delete(oid);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, gen] of wanted) if (gen === depth) shallow.push(oid);
    for (const boundary of shallowBoundaries) {
      const gen = wanted.get(boundary);
      if (gen !== undefined && gen < depth) {
        const obj = getObject(repo, boundary);
        if (obj?.type === 'commit') {
          const parents = parseCommit(obj.data).parents;
          if (parents.every((p) => wanted.has(p))) unshallow.push(boundary);
        }
      }
    }
  }
  return { pack: writePack(newObjects), shallow, unshallow };
}

/** Wrap bytes in sideband band-1 pkt-lines (max 65515 payload bytes each). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return Buffer.concat(parts);
}

function handleGitInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, service: string): void {
  const repo = findRepo(owner, name);
  if (!repo) { sendError(res, 404, 'Not Found'); return; }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { sendError(res, 400, 'Invalid service'); return; }
  const protocol = req.headers['git-protocol'] ?? '';
  let body: Buffer;
  let contentType: string;
  if (service === 'git-upload-pack' && protocol === 'version=2') {
    body = advertisementV2();
    contentType = 'application/x-git-upload-pack-advertisement';
  } else {
    body = advertisementV0(repo, service);
    contentType = service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  }
  sendRaw(res, 200, body, contentType);
}

function handleGitUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const protocol = req.headers['git-protocol'] ?? '';
  if (protocol === 'version=2') {
    const { lines } = decodePktLines(body);
    let command = '';
    let idx = 0;
    // First data packet is the command; then capability lines until delim.
    for (; idx < lines.length; idx++) {
      const line = lines[idx];
      if (line.kind === 'data') {
        const text = line.data.toString('utf8');
        if (text.startsWith('command=')) command = text.slice('command='.length).trim();
      } else if (line.kind === 'delim' || line.kind === 'flush') {
        idx += 1;
        break;
      }
    }
    const args: string[] = [];
    for (; idx < lines.length; idx++) {
      const line = lines[idx];
      if (line.kind === 'data') args.push(line.data.toString('utf8').trim());
      else break;
    }
    if (command === 'ls-refs') {
      const opts = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
      for (const arg of args) {
        if (arg === 'peel') opts.peel = true;
        else if (arg === 'symrefs') opts.symrefs = true;
        else if (arg === 'unborn') opts.unborn = true;
        else if (arg.startsWith('ref-prefix ')) opts.prefixes.push(arg.slice('ref-prefix '.length));
      }
      sendRaw(res, 200, lsRefsResponse(repo, opts), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      let done = false;
      for (const arg of args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) {
          const n = Number(arg.slice(7).trim());
          if (Number.isFinite(n) && n > 0) depth = n;
        } else if (arg === 'done') done = true;
      }
      const plan = computeFetchPack(repo, wants, haves, shallow, depth);
      const parts: Buffer[] = [];
      // Protocol v2: when the client sends 'done' it is finished negotiating, so the
      // acknowledgments section MUST be omitted (real git dies on it). When it does
      // not send 'done', the client is waiting for ACKs/NAK before deciding.
      if (!done) {
        parts.push(pktLine('acknowledgments\n'));
        if (haves.length === 0) {
          parts.push(pktLine('NAK\n'));
        } else {
          let acked = false;
          for (const have of haves) {
            if (wants.some((want) => isAncestor(repo, have, want))) {
              parts.push(pktLine(`ACK ${have}\n`));
              acked = true;
            }
          }
          if (!acked) parts.push(pktLine('NAK\n'));
          else parts.push(pktLine('ready\n'));
        }
        parts.push(PKT_DELIM);
      }
      if (depth !== undefined) {
        parts.push(pktLine('shallow-info\n'));
        for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
        for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
        parts.push(PKT_DELIM);
      }
      parts.push(pktLine('packfile\n'));
      parts.push(sidebandPack(plan.pack));
      parts.push(PKT_FLUSH);
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    sendError(res, 400, 'Unknown command');
    return;
  }

  // v0 upload-pack: want/have/shallow/deepen lines, then done.
  const { lines } = decodePktText(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    if (line === '\0FLUSH' || line === '\0DELIM') continue;
    const text = line.split('\0')[0];
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const plan = computeFetchPack(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  if (haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    let acked = false;
    for (const have of haves) {
      if (wants.some((want) => isAncestor(repo, have, want))) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(plan.pack));
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleGitReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  // Commands are pkt-lines up to the first flush; the rest is the pack.
  const { lines, next } = decodePktLines(body);
  const commands: Array<{ old: string; new: string; ref: string }> = [];
  for (const line of lines) {
    if (line.kind === 'flush') break;
    if (line.kind !== 'data') continue;
    const text = line.data.toString('utf8').split('\0')[0].trim();
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(text);
    if (match) commands.push({ old: match[1], new: match[2], ref: match[3] });
  }
  const packBytes = body.subarray(next);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      sendRaw(res, 500, Buffer.from(`unpack failed: ${err instanceof Error ? err.message : String(err)}`, 'utf8'), 'text/plain');
      return;
    }
  }
  const reportLines: string[] = ['unpack ok\n'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.new === ZERO_OID) {
      // Delete.
      if (current !== undefined && current === cmd.old) {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}\n`);
      } else {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      }
      continue;
    }
    const obj = getObject(repo, cmd.new);
    if (!obj) {
      reportLines.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    if (cmd.old === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else if (cmd.ref.startsWith('refs/heads/') && obj.type !== 'commit') {
        reportLines.push(`ng ${cmd.ref} not a commit\n`);
      } else {
        repo.refs.set(cmd.ref, cmd.new);
        reportLines.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    // Update.
    if (current === undefined || current !== cmd.old) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
    } else if (!isAncestor(repo, cmd.old, cmd.new)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
    } else {
      repo.refs.set(cmd.ref, cmd.new);
      reportLines.push(`ok ${cmd.ref}\n`);
    }
  }
  const report = Buffer.concat([encodePktLines(reportLines), PKT_FLUSH]);
  const parts: Buffer[] = [sidebandPack(report), PKT_FLUSH];
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// GraphQL (small lexer + parser + executor over the same store)
// ---------------------------------------------------------------------------

type GqlTokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface GqlToken { kind: GqlTokenKind; value: string }

function lexGql(input: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < input.length && input[i] !== '\n') i += 1; continue; }
    if (ch === '.' && input[i + 1] === '.' && input[i + 2] === '.') { tokens.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@&|'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else { out += input[j]; j += 1; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type GqlValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValueNode }> };

interface GqlFieldNode { kind: 'field'; name: string; alias?: string; args: Array<{ name: string; value: GqlValueNode }>; selections?: GqlSelectionNode[] }
interface GqlSpreadNode { kind: 'spread'; name: string }
interface GqlInlineNode { kind: 'inline'; typeCondition?: string; selections: GqlSelectionNode[] }
type GqlSelectionNode = GqlFieldNode | GqlSpreadNode | GqlInlineNode;
interface GqlOperationNode { kind: 'operation'; operation: 'query' | 'mutation'; name?: string; variables: Record<string, { defaultValue?: GqlValueNode }>; selections: GqlSelectionNode[] }
interface GqlFragmentNode { kind: 'fragment'; name: string; typeCondition: string; selections: GqlSelectionNode[] }
interface GqlDocument { operations: GqlOperationNode[]; fragments: Map<string, GqlFragmentNode> }

class GqlParser {
  private pos = 0;
  private readonly tokens: GqlToken[];
  constructor(tokens: GqlToken[]) {
    this.tokens = tokens;
  }

  private peek(): GqlToken { return this.tokens[this.pos]; }
  private next(): GqlToken { return this.tokens[this.pos++]; }
  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value}, got ${tok.value}`);
  }
  private expectName(value?: string): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`expected name, got ${tok.value}`);
    if (value !== undefined && tok.value !== value) throw new Error(`expected ${value}, got ${tok.value}`);
    return tok.value;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperationNode[] = [];
    const fragments = new Map<string, GqlFragmentNode>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ kind: 'operation', operation: 'query', variables: {}, selections: this.parseSelectionSet() });
      } else if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
        const operation = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const variables: Record<string, { defaultValue?: GqlValueNode }> = {};
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseTypeName();
            if (this.peek().kind === 'punct' && this.peek().value === '=') {
              this.next();
              variables[varName] = { defaultValue: this.parseValue() };
            } else {
              variables[varName] = {};
            }
          }
          this.expectPunct(')');
        }
        operations.push({ kind: 'operation', operation, name, variables, selections: this.parseSelectionSet() });
      } else if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${tok.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseTypeName(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseTypeName();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): GqlSelectionNode[] {
    this.expectPunct('{');
    const selections: GqlSelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelectionNode {
    const tok = this.peek();
    if (tok.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'inline', selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let name = first;
    let alias: string | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: GqlValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: GqlSelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): GqlValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'variable', name: this.expectName() };
    if (tok.kind === 'int') return { kind: 'int', value: Number(tok.value) };
    if (tok.kind === 'float') return { kind: 'float', value: Number(tok.value) };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: GqlValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: GqlValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token ${tok.value}`);
  }
}

function resolveGqlValue(node: GqlValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveGqlValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveGqlValue(f.value, variables);
      return out;
    }
  }
}

// Schema field lists (for introspection and field validation).
const GQL_SCHEMA: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'issue', 'issues', 'pullRequest', 'pullRequests'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'author'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  PullRequestFile: { kind: 'OBJECT', fields: ['path'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues'] },
  __Field: { kind: 'OBJECT', fields: ['name'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
};

const GQL_FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Repository', __type: '__Type' },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  Issue: { comments: 'IssueCommentConnection', author: 'User' },
  PullRequest: { files: 'PullRequestFileConnection' },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: '[PullRequest]', pageInfo: 'PageInfo' },
  PullRequestFileConnection: { nodes: '[PullRequestFile]', pageInfo: 'PageInfo' },
  IssueCommentConnection: { nodes: '[IssueComment]', pageInfo: 'PageInfo' },
  __Type: { fields: '[__Field]', enumValues: '[__EnumValue]' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
};

type GqlObject = Record<string, unknown> & { __typename: string };

function issueGqlObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', _repo: repo, _issue: issue, id: globalId('issue', repo.id, issue.number), number: issue.number, title: issue.title, state: issue.state.toUpperCase(), body: issue.body };
}
function prGqlObject(repo: Repo, pr: PullRequest): GqlObject {
  return { __typename: 'PullRequest', _repo: repo, _pr: pr, id: globalId('pr', repo.id, pr.number), number: pr.number, title: pr.title, state: pr.state.toUpperCase(), body: pr.body, headRefName: pr.head, baseRefName: pr.base, mergeable: prMergeable(repo, pr), merged: pr.merged };
}
function repoGqlObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', _repo: repo, id: globalId('repo', repo.id), databaseId: repo.id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`, viewerPermission: 'ADMIN', hasIssuesEnabled: true, description: repo.description, private: repo.private };
}

function encodeCursor(number: number): string {
  return b64urlEncode(`cursor:${number}`);
}
function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const decoded = b64urlDecode(cursor);
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = String(orderBy?.direction ?? 'DESC').toUpperCase();
  list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  const after = decodeCursor(args.after);
  if (after !== null) {
    list = direction === 'ASC' ? list.filter((i) => i.number > after) : list.filter((i) => i.number < after);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueGqlObject(repo, i)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: after !== null, startCursor, endCursor },
    totalCount: repo.issues.length,
  };
}

function prConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const list = [...repo.prs].sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => prGqlObject(repo, p)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor, endCursor },
    totalCount: repo.prs.length,
  };
}

/** Resolve one field's raw value (before sub-selection). */
function resolveGqlFieldValue(parentType: string, fieldName: string, parent: GqlObject, args: Record<string, unknown>): unknown {
  if (parentType === 'Query') {
    if (fieldName === 'viewer') {
      return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
    }
    if (fieldName === 'repository') {
      const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoGqlObject(repo) : null;
    }
    if (fieldName === 'node') {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.kind === 'repo') {
        const repo = [...repos.values()].find((r) => r.id === Number(parsed.parts[0]));
        return repo ? repoGqlObject(repo) : null;
      }
      if (parsed.kind === 'issue') {
        const repo = [...repos.values()].find((r) => r.id === Number(parsed.parts[0]));
        const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
        return repo && issue ? issueGqlObject(repo, issue) : null;
      }
      if (parsed.kind === 'pr') {
        const repo = [...repos.values()].find((r) => r.id === Number(parsed.parts[0]));
        const pr = repo?.prs.find((p) => p.number === Number(parsed.parts[1]));
        return repo && pr ? prGqlObject(repo, pr) : null;
      }
      return null;
    }
    if (fieldName === '__type') {
      const typeName = String(args.name ?? '');
      const type = GQL_SCHEMA[typeName];
      if (!type) return { __typename: '__Type', name: typeName, kind: null, fields: null, enumValues: null };
      return {
        __typename: '__Type',
        name: typeName,
        kind: type.kind,
        fields: type.fields ? type.fields.map((f) => ({ __typename: '__Field', name: f })) : null,
        enumValues: type.enumValues ? type.enumValues.map((e) => ({ __typename: '__EnumValue', name: e })) : null,
      };
    }
  }
  if (parentType === 'Repository') {
    const repo = parent._repo as Repo;
    if (fieldName === 'owner') return { __typename: 'User', login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 1002, name: repo.owner, email: '' };
    if (fieldName === 'defaultBranchRef') {
      const tip = resolveBranchRef(repo, repo.defaultBranch);
      return tip ? { __typename: 'Ref', name: repo.defaultBranch } : null;
    }
    if (fieldName === 'issue') {
      const issue = repo.issues.find((i) => i.number === Number(args.number));
      return issue ? issueGqlObject(repo, issue) : null;
    }
    if (fieldName === 'issues') return issueConnection(repo, args);
    if (fieldName === 'pullRequest') {
      const pr = repo.prs.find((p) => p.number === Number(args.number));
      return pr ? prGqlObject(repo, pr) : null;
    }
    if (fieldName === 'pullRequests') return prConnection(repo, args);
    // Scalar fields are stored on the object itself.
    if (fieldName in parent) return parent[fieldName];
  }
  if (parentType === 'Issue') {
    const repo = parent._repo as Repo;
    const issue = parent._issue as Issue;
    if (fieldName === 'comments') {
      const nodes = issue.comments.map((c) => ({ __typename: 'IssueComment', id: globalId('comment', repo.id, issue.number, c.id), body: c.body }));
      return { __typename: 'IssueCommentConnection', nodes, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length };
    }
    if (fieldName === 'author') return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
    if (fieldName in parent) return parent[fieldName];
  }
  if (parentType === 'PullRequest') {
    const repo = parent._repo as Repo;
    const pr = parent._pr as PullRequest;
    if (fieldName === 'files') {
      const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
      const headTip = repo.refs.get(`refs/heads/${pr.head}`);
      const nodes: GqlObject[] = [];
      if (baseTip && headTip) {
        const mergeBaseOid = mergeBase(repo, baseTip, headTip) ?? baseTip;
        const baseTree = new Map<string, { oid: string; mode: string }>();
        const headTree = new Map<string, { oid: string; mode: string }>();
        const baseCommit = getObject(repo, mergeBaseOid);
        const headCommit = getObject(repo, headTip);
        if (baseCommit) flattenTree(repo, parseCommit(baseCommit.data).tree, '', baseTree);
        if (headCommit) flattenTree(repo, parseCommit(headCommit.data).tree, '', headTree);
        const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
        for (const path of [...paths].sort()) {
          const b = baseTree.get(path);
          const h = headTree.get(path);
          if (b && h && b.oid === h.oid) continue;
          nodes.push({ __typename: 'PullRequestFile', path });
        }
      }
      const first = typeof args.first === 'number' ? args.first : nodes.length;
      const page = nodes.slice(0, first);
      return { __typename: 'PullRequestFileConnection', nodes: page, pageInfo: { __typename: 'PageInfo', hasNextPage: nodes.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length };
    }
    if (fieldName in parent) return parent[fieldName];
  }
  if (parentType === '__Type') {
    if (fieldName in parent) return parent[fieldName];
  }
  // Generic scalar passthrough.
  if (fieldName in parent) return parent[fieldName];
  return null;
}

function executeGqlSelection(
  selections: GqlSelectionNode[],
  parent: GqlObject | null,
  parentType: string,
  variables: Record<string, unknown>,
  errors: Array<{ message: string }>,
  fragments: Map<string, GqlFragmentNode>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      if (parent === null || parent === undefined) { out[sel.alias ?? sel.name] = null; continue; }
      if (sel.name === '__typename') { out[sel.alias ?? sel.name] = parentType; continue; }
      const schema = GQL_SCHEMA[parentType];
      const known = schema?.fields?.includes(sel.name) ?? false;
      if (!known && parentType !== 'Query') {
        // Unknown field on a known type: record the error, return null.
        errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".` });
        out[sel.alias ?? sel.name] = null;
        continue;
      }
      if (!known && parentType === 'Query') {
        errors.push({ message: `Cannot query field "${sel.name}" on type "Query".` });
        out[sel.alias ?? sel.name] = null;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const arg of sel.args) args[arg.name] = resolveGqlValue(arg.value, variables);
      const raw = resolveGqlFieldValue(parentType, sel.name, parent, args);
      if (!sel.selections || sel.selections.length === 0) {
        out[sel.alias ?? sel.name] = raw;
        continue;
      }
      if (raw === null || raw === undefined) { out[sel.alias ?? sel.name] = null; continue; }
      if (Array.isArray(raw)) {
        const itemType = (GQL_FIELD_TYPES[parentType]?.[sel.name] ?? '').replace(/^\[|\]$/g, '');
        out[sel.alias ?? sel.name] = raw.map((item) => {
          const itemObj = item as GqlObject;
          const type = itemObj.__typename ?? itemType;
          return executeGqlSelection(sel.selections!, itemObj, type, variables, errors, fragments);
        });
        continue;
      }
      const rawObj = raw as GqlObject;
      const type = rawObj.__typename ?? GQL_FIELD_TYPES[parentType]?.[sel.name] ?? parentType;
      out[sel.alias ?? sel.name] = executeGqlSelection(sel.selections, rawObj, type, variables, errors, fragments);
    } else if (sel.kind === 'spread') {
      const frag = fragments.get(sel.name);
      if (frag) Object.assign(out, executeGqlSelection(frag.selections, parent, parentType, variables, errors, fragments));
    } else if (sel.kind === 'inline') {
      const concrete = parent?.__typename ?? parentType;
      if (!sel.typeCondition || sel.typeCondition === concrete || sel.typeCondition === parentType) {
        Object.assign(out, executeGqlSelection(sel.selections, parent, concrete, variables, errors, fragments));
      }
    }
  }
  return out;
}

/** Execute one GraphQL operation body. Returns the response object. */
function executeGraphQL(body: unknown): Record<string, unknown> {
  const execOne = (single: Record<string, unknown>): Record<string, unknown> => {
    const query = String(single.query ?? '');
    const variables = (single.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof single.operationName === 'string' ? single.operationName : undefined;
    let doc: GqlDocument;
    try {
      doc = new GqlParser(lexGql(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: `Syntax Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
    const operation = operationName
      ? doc.operations.find((o) => o.name === operationName)
      : doc.operations[0];
    if (!operation) return { data: null, errors: [{ message: 'Must provide an operation.' }] };
    const errors: Array<{ message: string }> = [];
    if (operation.operation === 'mutation') {
      return executeGqlMutation(operation, variables, errors, doc.fragments);
    }
    const root: GqlObject = { __typename: 'Query' };
    const data = executeGqlSelection(operation.selections, root, 'Query', variables, errors, doc.fragments);
    return errors.length > 0 ? { data, errors } : { data };
  };
  if (Array.isArray(body)) return { __batch: body.map(execOne) } as unknown as Record<string, unknown>;
  return execOne(body as Record<string, unknown>);
}

/** Mutations: apply the side effect, then resolve the payload selection. */
function executeGqlMutation(
  operation: GqlOperationNode,
  variables: Record<string, unknown>,
  errors: Array<{ message: string }>,
  fragments: Map<string, GqlFragmentNode>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of operation.selections) {
    if (sel.kind !== 'field') continue;
    const args: Record<string, unknown> = {};
    for (const arg of sel.args) args[arg.name] = resolveGqlValue(arg.value, variables);
    const payload = applyGqlMutation(sel.name, args);
    if (payload === null) { out[sel.alias ?? sel.name] = null; continue; }
    if (!sel.selections || sel.selections.length === 0) { out[sel.alias ?? sel.name] = payload; continue; }
    out[sel.alias ?? sel.name] = executeGqlSelection(sel.selections, payload as GqlObject, (payload as GqlObject).__typename, variables, errors, fragments);
  }
  return errors.length > 0 ? { data: out, errors } : { data: out };
}

function applyGqlMutation(fieldName: string, args: Record<string, unknown>): GqlObject | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (fieldName === 'createIssue') {
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    if (!parsed || parsed.kind !== 'repo') return null;
    const repo = [...repos.values()].find((r) => r.id === Number(parsed.parts[0]));
    if (!repo) return null;
    const issue: Issue = {
      number: repo.nextIssue++, title: String(input.title ?? ''), body: String(input.body ?? ''),
      state: 'open', labels: [], comments: [], seq: repo.issues.length + 1,
    };
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: issueGqlObject(repo, issue) };
  }
  if (fieldName === 'closeIssue') {
    const parsed = parseGlobalId(String(input.issueId ?? ''));
    if (!parsed || parsed.kind !== 'issue') return null;
    const repo = [...repos.values()].find((r) => r.id === Number(parsed.parts[0]));
    const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
    if (!repo || !issue) return null;
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueGqlObject(repo, issue) };
  }
  if (fieldName === 'createPullRequest') {
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    if (!parsed || parsed.kind !== 'repo') return null;
    const repo = [...repos.values()].find((r) => r.id === Number(parsed.parts[0]));
    if (!repo) return null;
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const headSha = resolveBranchRef(repo, head);
    const baseSha = resolveBranchRef(repo, base);
    if (!headSha || !baseSha) return null;
    const pr: PullRequest = {
      number: repo.nextPr++, title: String(input.title ?? ''), body: String(input.body ?? ''),
      state: 'open', merged: false, head, base, headSha, baseSha,
      mergeCommitSha: null, mergedAt: null, seq: repo.prs.length + 1,
    };
    repo.prs.push(pr);
    return { __typename: 'CreatePullRequestPayload', pullRequest: prGqlObject(repo, pr) };
  }
  if (fieldName === 'mergePullRequest') {
    const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
    if (!parsed || parsed.kind !== 'pr') return null;
    const repo = [...repos.values()].find((r) => r.id === Number(parsed.parts[0]));
    const pr = repo?.prs.find((p) => p.number === Number(parsed.parts[1]));
    if (!repo || !pr || pr.state !== 'open') return null;
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    const headTip = repo.refs.get(`refs/heads/${pr.head}`);
    if (!baseTip || !headTip) return null;
    const mergeBaseOid = mergeBase(repo, baseTip, headTip);
    if (!mergeBaseOid) return null;
    const baseTree = new Map<string, { oid: string; mode: string }>();
    const headTree = new Map<string, { oid: string; mode: string }>();
    const tipTree = new Map<string, { oid: string; mode: string }>();
    const baseCommit = getObject(repo, mergeBaseOid);
    const headCommit = getObject(repo, headTip);
    const tipCommit = getObject(repo, baseTip);
    if (!baseCommit || !headCommit || !tipCommit) return null;
    flattenTree(repo, parseCommit(baseCommit.data).tree, '', baseTree);
    flattenTree(repo, parseCommit(headCommit.data).tree, '', headTree);
    flattenTree(repo, parseCommit(tipCommit.data).tree, '', tipTree);
    const { merged, conflict } = mergeFlatMaps(baseTree, headTree, tipTree);
    if (conflict) return null;
    const mergedTreeOid = treeFromFlat(repo, merged);
    const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.head}\n\n${pr.title}`;
    const mergeOid = storeObject(repo, 'commit', buildCommit(mergedTreeOid, [baseTip], message));
    repo.refs.set(`refs/heads/${pr.base}`, mergeOid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergeCommitSha = mergeOid;
    pr.mergedAt = FIXED_ISO;
    return { __typename: 'MergePullRequestPayload', pullRequest: prGqlObject(repo, pr) };
  }
  if (fieldName === 'addComment') {
    const parsed = parseGlobalId(String(input.subjectId ?? ''));
    if (!parsed || parsed.kind !== 'issue') return null;
    const repo = [...repos.values()].find((r) => r.id === Number(parsed.parts[0]));
    const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
    if (!repo || !issue) return null;
    const comment: IssueComment = { id: repo.nextComment++, body: String(input.body ?? '') };
    issue.comments.push(comment);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: globalId('comment', repo.id, issue.number, comment.id), body: comment.body } },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 over Streamable HTTP; modern server/discover era)
// ---------------------------------------------------------------------------

const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type McpCallResult =
  | { kind: 'ok'; text: string; structured: Record<string, unknown> }
  | { kind: 'tool-error'; text: string }
  | { kind: 'rpc-error'; code: number; message: string };

function mcpResolveRepo(args: Record<string, unknown>): Repo | null {
  const fullName = asString(args.full_name);
  if (fullName) {
    const [owner, name] = fullName.split('/');
    if (owner && name) return findRepo(owner, name) ?? null;
  }
  const owner = asString(args.owner);
  const repo = asString(args.repo);
  if (owner && repo) return findRepo(owner, repo) ?? null;
  return null;
}

function callMcpTool(name: string, args: Record<string, unknown>): McpCallResult {
  if (name === 'create_repo') {
    const repoName = asString(args.name);
    if (!repoName) return { kind: 'tool-error', text: 'Missing required argument: name' };
    if (findRepo(VIEWER.login, repoName)) return { kind: 'tool-error', text: `Repository ${VIEWER.login}/${repoName} already exists` };
    const repo = newRepo(VIEWER.login, repoName, asString(args.description) ?? '', asBoolean(args.private) ?? false);
    const structured = { name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, description: repo.description };
    return { kind: 'ok', text: JSON.stringify(structured), structured };
  }
  if (name === 'get_repo') {
    const repo = mcpResolveRepo(args);
    if (!repo) return { kind: 'tool-error', text: 'Repository not found' };
    const structured = { name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: repo.owner, private: repo.private, description: repo.description, default_branch: repo.defaultBranch };
    return { kind: 'ok', text: `Repository ${repo.owner}/${repo.name} (${repo.private ? 'private' : 'public'}): ${repo.description}`, structured };
  }
  if (name === 'create_issue') {
    const repo = mcpResolveRepo(args);
    if (!repo) return { kind: 'tool-error', text: 'Repository not found' };
    const title = asString(args.title);
    if (!title) return { kind: 'tool-error', text: 'Missing required argument: title' };
    const issue: Issue = {
      number: repo.nextIssue++, title, body: asString(args.body) ?? '',
      state: 'open', labels: [], comments: [], seq: repo.issues.length + 1,
    };
    repo.issues.push(issue);
    const structured = { number: issue.number, title: issue.title, state: issue.state, url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}` };
    return { kind: 'ok', text: `Created issue number: ${issue.number} — ${issue.title}`, structured };
  }
  if (name === 'list_issues') {
    const repo = mcpResolveRepo(args);
    if (!repo) return { kind: 'tool-error', text: 'Repository not found' };
    const state = asString(args.state) ?? 'open';
    const list = repo.issues.filter((i) => state === 'all' || i.state === state);
    const structured = { issues: list.map((i) => ({ number: i.number, title: i.title, state: i.state })) };
    const text = list.length > 0
      ? list.map((i) => `number: ${i.number} — ${i.title} (${i.state})`).join('\n')
      : 'No issues found';
    return { kind: 'ok', text, structured };
  }
  if (name === 'create_pull_request') {
    const repo = mcpResolveRepo(args);
    if (!repo) return { kind: 'tool-error', text: 'Repository not found' };
    const title = asString(args.title);
    const head = asString(args.head);
    const base = asString(args.base);
    if (!title || !head || !base) return { kind: 'tool-error', text: 'Missing required argument: title, head, or base' };
    const headSha = resolveBranchRef(repo, head);
    const baseSha = resolveBranchRef(repo, base);
    if (!headSha || !baseSha) return { kind: 'tool-error', text: 'Head or base branch not found' };
    const pr: PullRequest = {
      number: repo.nextPr++, title, body: '',
      state: 'open', merged: false, head, base, headSha, baseSha,
      mergeCommitSha: null, mergedAt: null, seq: repo.prs.length + 1,
    };
    repo.prs.push(pr);
    const structured = { number: pr.number, title: pr.title, state: pr.state, head: pr.head, base: pr.base };
    return { kind: 'ok', text: `Created pull request number: ${pr.number} — ${pr.title}`, structured };
  }
  if (name === 'merge_pull_request') {
    const repo = mcpResolveRepo(args);
    if (!repo) return { kind: 'tool-error', text: 'Repository not found' };
    const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    const pr = repo.prs.find((p) => p.number === pullNumber);
    if (!pr) return { kind: 'tool-error', text: 'Pull request not found' };
    if (pr.state !== 'open') return { kind: 'tool-error', text: 'Pull request is not open' };
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    const headTip = repo.refs.get(`refs/heads/${pr.head}`);
    if (!baseTip || !headTip) return { kind: 'tool-error', text: 'Head or base branch not found' };
    const mergeBaseOid = mergeBase(repo, baseTip, headTip);
    if (!mergeBaseOid) return { kind: 'tool-error', text: 'No merge base' };
    const baseTree = new Map<string, { oid: string; mode: string }>();
    const headTree = new Map<string, { oid: string; mode: string }>();
    const tipTree = new Map<string, { oid: string; mode: string }>();
    const baseCommit = getObject(repo, mergeBaseOid);
    const headCommit = getObject(repo, headTip);
    const tipCommit = getObject(repo, baseTip);
    if (!baseCommit || !headCommit || !tipCommit) return { kind: 'tool-error', text: 'Merge failed' };
    flattenTree(repo, parseCommit(baseCommit.data).tree, '', baseTree);
    flattenTree(repo, parseCommit(headCommit.data).tree, '', headTree);
    flattenTree(repo, parseCommit(tipCommit.data).tree, '', tipTree);
    const { merged, conflict } = mergeFlatMaps(baseTree, headTree, tipTree);
    if (conflict) return { kind: 'tool-error', text: 'Merge conflict' };
    const mergedTreeOid = treeFromFlat(repo, merged);
    const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.head}\n\n${pr.title}`;
    const mergeOid = storeObject(repo, 'commit', buildCommit(mergedTreeOid, [baseTip], message));
    repo.refs.set(`refs/heads/${pr.base}`, mergeOid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergeCommitSha = mergeOid;
    pr.mergedAt = FIXED_ISO;
    const structured = { merged: true, sha: mergeOid, number: pr.number };
    return { kind: 'ok', text: `Merged pull request number: ${pr.number} — ${mergeOid}`, structured };
  }
  return { kind: 'rpc-error', code: -32601, message: `Method not found: ${name}` };
}

function handleMcp(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const req = body as Record<string, unknown>;
  const id = req.id;
  const hasId = id !== undefined && id !== null;
  const method = req.method;
  if (typeof method !== 'string') {
    return hasId ? { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } } : null;
  }
  if (method === 'notifications/initialized') return null;
  if (!hasId) return null;
  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0', id,
      result: {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: FORGE_NAME, version: FORGE_VERSION } },
      },
    };
  }
  if (method === 'initialize') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    if (!supported.includes(offered)) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unsupported protocol version: ${offered}` } };
    }
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }
  if (method === 'tools/call') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const result = callMcpTool(name, args);
    if (result.kind === 'rpc-error') {
      return { jsonrpc: '2.0', id, error: { code: result.code, message: result.message } };
    }
    if (result.kind === 'tool-error') {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text }], isError: true } };
    }
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text }], structuredContent: result.structured, isError: false } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const url = new URL(req.url ?? '/', 'http://localhost');
        const segments = url.pathname.split('/').filter((s) => s.length > 0);
        if (!authorized(req)) { sendError(res, 401, 'Requires authentication'); return; }

        // GraphQL
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql' && req.method === 'POST') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Unexpected token in JSON' }] });
            return;
          }
          const result = executeGraphQL(parsed);
          if (result && typeof result === 'object' && '__batch' in result) {
            sendJson(res, 200, (result as Record<string, unknown>).__batch);
            return;
          }
          sendJson(res, 200, result);
          return;
        }

        // MCP
        if (segments.length === 1 && segments[0] === 'mcp' && req.method === 'POST') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          const response = handleMcp(parsed);
          if (response === null) {
            res.writeHead(202);
            res.end();
            return;
          }
          sendJson(res, 200, response);
          return;
        }

        // Git smart HTTP: /:owner/:repo.git/...
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          const owner = decodeURIComponent(segments[0]);
          const name = decodeURIComponent(segments[1].slice(0, -4));
          const repo = findRepo(owner, name);
          if (!repo) { sendError(res, 404, 'Not Found'); return; }
          if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs' && req.method === 'GET') {
            handleGitInfoRefs(req, res, owner, name, url.searchParams.get('service') ?? '');
            return;
          }
          if (segments.length === 3 && segments[2] === 'git-upload-pack' && req.method === 'POST') {
            handleGitUploadPack(req, res, repo, body);
            return;
          }
          if (segments.length === 3 && segments[2] === 'git-receive-pack' && req.method === 'POST') {
            handleGitReceivePack(req, res, repo, body);
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }

        // REST v3
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          const handled = await handleRest(req, res, body);
          if (!handled) sendError(res, 404, 'Not Found');
          return;
        }

        sendError(res, 404, 'Not Found');
      } catch (err) {
        try {
          sendError(res, 500, err instanceof Error ? err.message : String(err));
        } catch {
          // The response is already gone; nothing more to do.
        }
      }
    })();
  });
  return server;
}
