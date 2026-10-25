// Work out what a service map needs re-read after the repos moved on.
// Reads state.json (written by build_svcmap.py --state) and the current data files,
// maps the git diff onto node ids through their `ev` evidence, and prints a work order.
//
// usage: node svcmap_diff.js [--state state.json] [--out out/work-order.json] DATA.js [MORE.js ...]
//
// Exit 0 with a work order, 2 when the map is already current, 1 on a problem
// that forces a full rebuild (no state file, repo gone, template changed).
const fs = require('fs'), path = require('path'), vm = require('vm');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
let statePath = 'state.json', outPath = null; const dataFiles = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--state') statePath = argv[++i];
  else if (argv[i] === '--out') outPath = argv[++i];
  else dataFiles.push(argv[i]);
}
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (!fs.existsSync(statePath)) die(`no ${statePath}: this map has no recorded build, so do a full build`);
if (!dataFiles.length) die('usage: node svcmap_diff.js [--state state.json] [--out work-order.json] DATA.js ...');

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const git = (root, ...args) => {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};
const sha256 = p => require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/* ---------- 1. load the data files for real, so ev is read the way the page reads it ---------- */
const sandbox = {
  String, Math, JSON, Object, Array, Number, Date, isFinite, isNaN, parseInt, parseFloat, console,
  L: String.raw,
  esc: s => String(s ?? ''), fmt: x => String(x), clamp: (x, a, b) => Math.min(b, Math.max(a, x)),
  bars: () => '', plot: () => '',
};
const src = dataFiles.map(p => fs.readFileSync(p, 'utf8')).join('\n');
// `const N = ...` is a lexical binding, not a property of the sandbox, so take the script's value.
const tail = '\n;({N:typeof N<"u"?N:null, EXTRA:typeof EXTRA<"u"?EXTRA:{}, FX:typeof FX<"u"?FX:{}});';
let loaded;
vm.createContext(sandbox);
try { loaded = vm.runInContext(src + tail, sandbox, { timeout: 10000 }); }
catch (e) { die('cannot evaluate the data files: ' + e.message); }
const { N, EXTRA, FX } = loaded;
if (!N) die('data files declare no N');

// Merge EXTRA into nodes exactly as the template does, then collect every evidence reference.
const nodes = [];
(function walk(n) {
  const x = EXTRA[n.id];
  if (x) { if (x.patch) Object.assign(n, x.patch); ['ev', 'c'].forEach(k => { if (x[k] !== undefined) n[k] = x[k]; }); }
  nodes.push(n); (n.kids || []).forEach(walk);
})(N);

// "repo/path/File.java:41" or ":41-77"; several refs may be comma-separated. No line numbers = whole file.
function parseEv(ev) {
  return String(ev).split(',').map(s => s.trim()).filter(Boolean).map(ref => {
    const m = ref.match(/^(.*?):(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return { file: ref, lo: null, hi: null };
    return { file: m[1], lo: +m[2], hi: m[3] ? +m[3] : +m[2] };
  });
}
const cites = [];   // {owner, kind, title, file, lo, hi}
for (const n of nodes) if (n.ev) for (const r of parseEv(n.ev)) cites.push({ owner: n.id, kind: n.k, title: n.t, ...r });
for (const [id, f] of Object.entries(FX)) if (f && f.ev) for (const r of parseEv(f.ev)) cites.push({ owner: id, kind: 'formula', title: f.t, ...r });

/* ---------- 2. ask each repo what moved ---------- */
const repos = state.repos || [];
if (!repos.length) die('state.json records no repos; rebuild with --repo NAME=PATH to enable refreshes');

const changed = new Map();   // "repo/path" -> {status, repo, hunks:[{oldStart,oldLen,newLen}]|null, to?}
const repoReport = [];
let forceFull = false;

for (const r of repos) {
  const root = path.resolve(path.dirname(statePath), r.path || r.name);
  const rep = { name: r.name, path: r.path, from: r.head, ok: true };
  if (!fs.existsSync(root)) { rep.ok = false; rep.why = 'repo path is gone'; forceFull = true; repoReport.push(rep); continue; }
  const head = git(root, 'rev-parse', 'HEAD');

  if (r.head && head) {
    rep.to = head;
    rep.commits = +(git(root, 'rev-list', '--count', `${r.head}..HEAD`) || 0);
    rep.dirty = !!git(root, 'status', '--porcelain');
    if (git(root, 'cat-file', '-t', r.head) !== 'commit') {
      rep.ok = false; rep.why = `recorded commit ${r.head.slice(0, 8)} is not in this repo (force-push or shallow clone)`; forceFull = true; repoReport.push(rep); continue;
    }
    // One diff from the recorded commit to the working tree: covers committed and uncommitted alike.
    const names = git(root, 'diff', '-M', '--name-status', r.head) || '';
    for (const line of names.split('\n').filter(Boolean)) {
      const f = line.split('\t'); const st = f[0];
      if (st.startsWith('R')) changed.set(`${r.name}/${f[1]}`, { status: 'R', repo: r.name, to: `${r.name}/${f[2]}`, similarity: +st.slice(1) || null, hunks: null });
      else changed.set(`${r.name}/${f[1]}`, { status: st[0], repo: r.name, hunks: null });
    }
    const untracked = git(root, 'ls-files', '--others', '--exclude-standard') || '';
    for (const f of untracked.split('\n').filter(Boolean)) changed.set(`${r.name}/${f}`, { status: 'A', repo: r.name, hunks: null });
  } else {
    // No git (or no recorded head): fall back to the hashes of the files the map cites.
    rep.mode = 'hash';
    const files = state.files || {};
    let n = 0;
    for (const [rel, want] of Object.entries(files)) {
      if (!rel.startsWith(r.name + '/')) continue;
      const abs = path.join(root, rel.slice(r.name.length + 1));
      if (!fs.existsSync(abs)) { changed.set(rel, { status: 'D', repo: r.name, hunks: null }); n++; }
      else if (sha256(abs) !== want) { changed.set(rel, { status: 'M', repo: r.name, hunks: null }); n++; }
    }
    if (!Object.keys(files).length) { rep.ok = false; rep.why = 'no git and no recorded file hashes'; forceFull = true; }
  }
  repoReport.push(rep);
}

// A file git calls changed but whose content still hashes to what the build saw is not changed:
// that is how an uncommitted edit already folded into the map, or a reverted one, stops reappearing.
for (const [rel, e] of [...changed]) {
  const want = (state.files || {})[rel];
  if (!want || (e.status !== 'M' && e.status !== 'A')) continue;
  const r = repos.find(x => x.name === e.repo); if (!r) continue;
  const abs = path.join(path.resolve(path.dirname(statePath), r.path || r.name), rel.slice(e.repo.length + 1));
  if (fs.existsSync(abs) && sha256(abs) === want) changed.delete(rel);
}
for (const rep of repoReport) rep.changedFiles = [...changed.values()].filter(e => e.repo === rep.name).length;

// Hunk ranges, in the recorded commit's line numbers, for the files some node cites.
function hunksFor(rel) {
  const e = changed.get(rel); if (!e || e.hunks || e.status !== 'M') return e && e.hunks;
  const r = repos.find(x => x.name === e.repo); if (!r || !r.head) return (e.hunks = null);
  const root = path.resolve(path.dirname(statePath), r.path || r.name);
  const d = git(root, 'diff', '-U0', r.head, '--', rel.slice(e.repo.length + 1));
  if (d === null) return (e.hunks = null);
  const hs = [];
  for (const m of d.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm))
    hs.push({ oldStart: +m[1], oldLen: m[2] === undefined ? 1 : +m[2], newLen: m[4] === undefined ? 1 : +m[4] });
  return (e.hunks = hs);
}

/* ---------- 3. map changed files onto node ids ---------- */
const order = { mode: 'refresh', slug: state.slug, builtAt: state.built, repos: repoReport,
  reread: [], drift: [], orphaned: [], renamed: [], formulas: [], scan: [] };

if (state.template_sha256) {
  const tpl = dataFiles.map(p => path.join(path.dirname(p), 'svcmap-template.html')).find(fs.existsSync)
    || (fs.existsSync('svcmap-template.html') ? 'svcmap-template.html' : null);
  if (tpl && sha256(tpl) !== state.template_sha256) { order.template_changed = true; }
}

const touchedOwners = new Set();
for (const c of cites) {
  const e = changed.get(c.file); if (!e) continue;
  touchedOwners.add(c.owner);
  const base = { id: c.owner, k: c.kind, t: c.title, file: c.file, range: c.lo ? (c.lo === c.hi ? String(c.lo) : `${c.lo}-${c.hi}`) : null };
  if (e.status === 'D') { order.orphaned.push({ ...base, why: 'the file it cites was deleted' }); continue; }
  if (e.status === 'R') { order.renamed.push({ ...base, to: e.to, similarity: e.similarity, why: e.similarity === 100 ? 'file renamed, contents identical: re-anchor ev only' : 'file renamed and edited: re-read' }); continue; }
  if (c.kind === 'formula') { order.formulas.push({ ...base, why: 'a source or config file it models changed' }); continue; }
  if (e.status === 'A') { order.reread.push({ ...base, why: 'the file it cites is new to this build' }); continue; }
  if (c.lo === null) { order.reread.push({ ...base, why: 'the file changed and the node cites no line range' }); continue; }

  const hs = hunksFor(c.file);
  if (!hs) { order.reread.push({ ...base, why: 'the file changed (no hunk detail available)' }); continue; }
  let delta = 0, overlap = false;
  for (const h of hs) {
    const hLo = h.oldStart, hHi = h.oldStart + Math.max(h.oldLen, 1) - 1;
    if (h.oldLen === 0) { if (hLo >= c.lo && hLo < c.hi) overlap = true; else if (hLo < c.lo) delta += h.newLen; }
    else if (hHi < c.lo) delta += h.newLen - h.oldLen;
    else if (hLo <= c.hi) overlap = true;
  }
  if (overlap) order.reread.push({ ...base, why: 'an edit lands inside its line range' });
  else if (delta) order.drift.push({ ...base, delta, suggest: c.lo === c.hi ? String(c.lo + delta) : `${c.lo + delta}-${c.hi + delta}`, why: 'edits above it only: shift ev, no re-read' });
}

// Changed files no node cites: new entry points, new external calls, deleted dead code.
const citedFiles = new Set(cites.map(c => c.file));
for (const [rel, e] of changed) {
  if (citedFiles.has(rel)) continue;
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock)$/.test(rel)) continue;
  if (/\.(md|txt|png|jpg|jpeg|svg|gif|ico|lock)$/i.test(rel)) continue;
  // Tests, fixtures and vendored trees rarely become nodes; they would otherwise sit in `scan` forever.
  if (/(^|\/)(test|tests|__tests__|spec|fixtures|testdata|node_modules|vendor|dist|build|\.github)\//i.test(rel)) continue;
  if (/(\.(test|spec)\.[a-z]+|_test\.go|Tests?\.(java|kt|cs))$/i.test(rel)) continue;
  order.scan.push({ file: rel, status: e.status, to: e.to,
    why: e.status === 'A' ? 'new file: does it add a node, a call or a branch?'
      : e.status === 'D' ? 'deleted file no node cited: confirm nothing on the map depended on it'
        : 'changed file no node cites: was it missed in the first read?' });
}

order.counts = { reread: order.reread.length, drift: order.drift.length, orphaned: order.orphaned.length,
  renamed: order.renamed.length, formulas: order.formulas.length, scan: order.scan.length,
  changedFiles: changed.size, nodes: nodes.length, nodesUntouched: nodes.length - touchedOwners.size };

/* ---------- 4. report ---------- */
if (outPath) { fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify(order, null, 1)); }
console.log(JSON.stringify(order, null, 1));

const c = order.counts;
if (forceFull) { console.error('\nRESULT: FULL REBUILD — ' + repoReport.filter(r => !r.ok).map(r => `${r.name}: ${r.why}`).join('; ')); process.exit(1); }
if (order.template_changed) console.error('\nNOTE: the template changed since this build; rebuild the page from the current template (the data still stands).');
if (!c.changedFiles) { console.error('\nRESULT: CURRENT — no repo moved since ' + (state.built || 'the last build')); process.exit(2); }
console.error(`\nRESULT: REFRESH — ${c.changedFiles} changed file(s): re-read ${c.reread}, shift ${c.drift}, orphaned ${c.orphaned}, renamed ${c.renamed}, formulas ${c.formulas}, scan ${c.scan}; ${c.nodesUntouched}/${c.nodes} nodes untouched`);
process.exit(0);
