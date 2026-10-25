#!/usr/bin/env python3
"""Work out what a service map needs re-read after the repos moved on.

usage: python3 svcmap_diff.py [--state state.json] [--out out/work-order.json] DATA.js [MORE.js ...]

Reads state.json (written by build_svcmap.py --state), diffs each repo, and maps the
changed files onto node ids through their `ev` evidence. Prints a work order as JSON.

Exit 0 with a work order, 2 when the map is already current, 1 when a full rebuild is
needed (no state file, repo gone, recorded commit absent). Standard library only."""
import argparse, hashlib, json, os, re, subprocess, sys

ap = argparse.ArgumentParser(add_help=True)
ap.add_argument("data", nargs="+")
ap.add_argument("--state", default="state.json")
ap.add_argument("--out")
a = ap.parse_args()


def die(msg, code=1):
    print(msg, file=sys.stderr); sys.exit(code)


if not os.path.isfile(a.state):
    die(f"no {a.state}: this map has no recorded build, so do a full build")
state = json.load(open(a.state, encoding="utf-8"))
sdir = os.path.dirname(os.path.abspath(a.state))


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 16), b""): h.update(b)
    return h.hexdigest()


def git(root, *args):
    try:
        r = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None
    except OSError:
        return None


# ---------- 1. pull owner -> ev pairs out of the data files ----------
# There is no JS engine here, so the data is scanned rather than evaluated: track object
# nesting while skipping strings, L`...` templates, comments and regex literals, so that
# braces and quotes inside a `logic` or `req` block cannot desync the scan. A missed `ev`
# is safe (its file simply shows up under `scan` instead); a misattributed one is not,
# so an owner that resolves to nothing is reported rather than guessed at.
ID_RE = re.compile(r"[A-Za-z_$][\w$]*")
# A `/` starts a regex (not a division) when the last meaningful character is one of these.
REGEX_OK_AFTER = set("(,=:[!&|?{};+-*%~^<>") | {"\n"}


def scan_ev(src):
    pairs, warnings, meta, all_ids = [], [], {}, set()
    frames = []           # one per open `{`: the key that opened it, plus its id/t/k values
    pending_key = None    # the most recent `key:` seen at this level
    last_sig = "\n"       # last significant char, for the regex-vs-division call
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        # --- comments ---
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            i = src.find("\n", i); i = n if i < 0 else i; continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2); i = n if j < 0 else j + 2; continue
        # --- regex literal ---
        if c == "/" and last_sig in REGEX_OK_AFTER:
            j, in_class = i + 1, False
            while j < n:
                d = src[j]
                if d == "\\": j += 2; continue
                if d == "[": in_class = True
                elif d == "]": in_class = False
                elif d == "/" and not in_class: break
                elif d == "\n": break
                j += 1
            i = j + 1; last_sig = "/"; continue
        # --- strings and template literals ---
        if c in "\"'":
            j, buf = i + 1, []
            while j < n:
                d = src[j]
                if d == "\\": buf.append(src[j + 1:j + 2]); j += 2; continue
                if d == c: break
                buf.append(d); j += 1
            val = "".join(buf)
            if pending_key == "ev":
                owner = None
                for f in reversed(frames):
                    if f["id"]: owner = f["id"]; break
                else:
                    # EXTRA[id] / FX[id]: the frame one level inside the container holds the id
                    if len(frames) > 1 and frames[1]["key"]: owner = frames[1]["key"]
                    elif frames and frames[0]["key"]: owner = frames[0]["key"]
                (pairs if owner else warnings).append((owner, val) if owner else val)
                pending_key = None
            elif pending_key in ("id", "t", "k") and frames:
                frames[-1][pending_key] = val; pending_key = None
            i = j + 1; last_sig = c; continue
        if c == "`":
            j = i + 1
            while j < n:
                d = src[j]
                if d == "\\": j += 2; continue
                if d == "`": break
                if d == "$" and src[j + 1:j + 2] == "{":   # interpolation: balance its braces
                    k, depth = j + 2, 1
                    while k < n and depth:
                        if src[k] in "\"'`":
                            q, k = src[k], k + 1
                            while k < n and src[k] != q:
                                k += 2 if src[k] == "\\" else 1
                        elif src[k] == "{": depth += 1
                        elif src[k] == "}": depth -= 1
                        k += 1
                    j = k; continue
                j += 1
            i = j + 1; last_sig = "`"; pending_key = None; continue
        # --- structure ---
        if c == "{":
            frames.append({"key": pending_key, "id": None, "t": None, "k": None}); pending_key = None
        elif c == "}":
            if frames:
                f = frames.pop()
                # Remember each node's title and kind so the work order reads for a human too.
                # A node is keyed by its id; an EXTRA/FX entry by the key that opened its object.
                # Only a node carries both id and k; an FX input widget has id and type,
                # so requiring k keeps widget ids out of the node count.
                if f["id"] and f["k"]: all_ids.add(f["id"])
                name = f["id"] or (f["key"] if len(frames) == 1 else None)
                if name and (f["t"] or f["k"]):
                    m = meta.setdefault(name, {})
                    if f["t"]: m.setdefault("t", f["t"])
                    if f["k"]: m.setdefault("k", f["k"])
            pending_key = None
        elif c in "[]":
            pending_key = None
        elif c == ":":
            pass                      # the key was captured by the identifier branch below
        elif c == ",":
            pending_key = None
        elif ID_RE.match(c):
            m = ID_RE.match(src, i)
            word = m.group(0)
            k = m.end()
            while k < n and src[k] in " \t\n": k += 1
            if k < n and src[k] == ":": pending_key = word
            i = m.end(); last_sig = word[-1]; continue
        if not c.isspace(): last_sig = c
        i += 1
    return pairs, warnings, meta, all_ids


src = "\n".join(open(p, encoding="utf-8").read() for p in a.data)
pairs, ev_warnings, meta, all_ids = scan_ev(src)

# "repo/path/File.java:41" or ":41-77"; several refs may be comma-separated.
REF_RE = re.compile(r"^(.*?):(\d+)(?:\s*-\s*(\d+))?$")
cites = []        # {"owner","file","lo","hi"}
for owner, ev in pairs:
    for ref in (r.strip() for r in ev.split(",")):
        if not ref: continue
        m = REF_RE.match(ref)
        if m: cites.append({"owner": owner, "file": m.group(1), "lo": int(m.group(2)),
                            "hi": int(m.group(3) or m.group(2))})
        else: cites.append({"owner": owner, "file": ref, "lo": None, "hi": None})
if not cites:
    die("no `ev` evidence found in the data files, so a diff cannot be mapped onto nodes; "
        "give every node repo-relative file:line evidence, or do a full build")

# ---------- 2. ask each repo what moved ----------
repos = state.get("repos") or []
if not repos:
    die("state.json records no repos; rebuild with --repo NAME=PATH to enable refreshes")

changed, repo_report, force_full = {}, [], False
for r in repos:
    root = os.path.normpath(os.path.join(sdir, r.get("path") or r["name"]))
    rep = {"name": r["name"], "path": r.get("path"), "from": r.get("head"), "ok": True}
    if not os.path.isdir(root):
        rep.update(ok=False, why="repo path is gone"); force_full = True; repo_report.append(rep); continue
    head = git(root, "rev-parse", "HEAD")
    if r.get("head") and head:
        rep["to"] = head
        rep["commits"] = int(git(root, "rev-list", "--count", f"{r['head']}..HEAD") or 0)
        rep["dirty"] = bool(git(root, "status", "--porcelain"))
        if git(root, "cat-file", "-t", r["head"]) != "commit":
            rep.update(ok=False, why=f"recorded commit {r['head'][:8]} is not in this repo "
                                     "(force-push or shallow clone)")
            force_full = True; repo_report.append(rep); continue
        # One diff from the recorded commit to the working tree: committed and uncommitted alike.
        for line in (git(root, "diff", "-M", "--name-status", r["head"]) or "").splitlines():
            f = line.split("\t")
            if not f or not f[0]: continue
            if f[0].startswith("R") and len(f) >= 3:
                changed[f"{r['name']}/{f[1]}"] = {"status": "R", "repo": r["name"],
                    "to": f"{r['name']}/{f[2]}", "similarity": int(f[0][1:] or 0) or None, "hunks": None}
            elif len(f) >= 2:
                changed[f"{r['name']}/{f[1]}"] = {"status": f[0][0], "repo": r["name"], "hunks": None}
        for f in (git(root, "ls-files", "--others", "--exclude-standard") or "").splitlines():
            changed[f"{r['name']}/{f}"] = {"status": "A", "repo": r["name"], "hunks": None}
    else:
        # No git (or no recorded head): compare the hashes of the files the map cites.
        rep["mode"] = "hash"
        files = state.get("files") or {}
        for rel, want in files.items():
            if not rel.startswith(r["name"] + "/"): continue
            abs_p = os.path.join(root, rel[len(r["name"]) + 1:])
            if not os.path.isfile(abs_p):
                changed[rel] = {"status": "D", "repo": r["name"], "hunks": None}
            elif sha256(abs_p) != want:
                changed[rel] = {"status": "M", "repo": r["name"], "hunks": None}
        if not files:
            rep.update(ok=False, why="no git and no recorded file hashes"); force_full = True
    repo_report.append(rep)

# A file git calls changed but whose content still hashes to what the build saw is not changed:
# that is how an uncommitted edit already folded into the map, or a reverted one, stops reappearing.
by_name = {r["name"]: r for r in repos}
for rel in list(changed):
    e = changed[rel]
    want = (state.get("files") or {}).get(rel)
    if not want or e["status"] not in ("M", "A"): continue
    r = by_name.get(e["repo"])
    if not r: continue
    abs_p = os.path.join(os.path.normpath(os.path.join(sdir, r.get("path") or r["name"])),
                         rel[len(e["repo"]) + 1:])
    if os.path.isfile(abs_p) and sha256(abs_p) == want: del changed[rel]
for rep in repo_report:
    rep["changedFiles"] = sum(1 for e in changed.values() if e["repo"] == rep["name"])

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", re.M)


def hunks_for(rel):
    """Hunk ranges, in the recorded commit's line numbers, for a modified file."""
    e = changed[rel]
    if e["hunks"] is not None or e["status"] != "M": return e["hunks"]
    r = by_name.get(e["repo"])
    if not r or not r.get("head"): return None
    root = os.path.normpath(os.path.join(sdir, r.get("path") or r["name"]))
    d = git(root, "diff", "-U0", r["head"], "--", rel[len(e["repo"]) + 1:])
    if d is None: return None
    e["hunks"] = [{"oldStart": int(m.group(1)), "oldLen": 1 if m.group(2) is None else int(m.group(2)),
                   "newLen": 1 if m.group(4) is None else int(m.group(4))} for m in HUNK_RE.finditer(d)]
    return e["hunks"]


# ---------- 3. map changed files onto owners ----------
order = {"mode": "refresh", "slug": state.get("slug"), "builtAt": state.get("built"),
         "repos": repo_report, "reread": [], "drift": [], "orphaned": [], "renamed": [],
         "formulas": [], "scan": []}
if ev_warnings:
    order["warn_evWithoutOwner"] = sorted(set(ev_warnings))

tpl = os.path.join(sdir, "svcmap-template.html")
if state.get("template_sha256") and os.path.isfile(tpl) and sha256(tpl) != state["template_sha256"]:
    order["template_changed"] = True

# FX ids own formulas; everything else is a node. The scan cannot tell them apart, so take
# the ids declared inside the FX object as the formula set.
fx_m = re.search(r"\b(?:const|let|var)\s+FX\s*=\s*\{", src)
fx_ids = set()
if fx_m:
    depth, i = 1, fx_m.end()
    while i < len(src) and depth:
        if src[i] == "{": depth += 1
        elif src[i] == "}": depth -= 1
        i += 1
    for m in re.finditer(r"[{,]\s*([A-Za-z_$][\w$]*)\s*:", src[fx_m.end() - 1:i]):
        fx_ids.add(m.group(1))

touched = set()
for c in cites:
    e = changed.get(c["file"])
    if not e: continue
    touched.add(c["owner"])
    rng = None if c["lo"] is None else (str(c["lo"]) if c["lo"] == c["hi"] else f"{c['lo']}-{c['hi']}")
    info = meta.get(c["owner"], {})
    base = {"id": c["owner"], "k": info.get("k"), "t": info.get("t"),
            "file": c["file"], "range": rng}
    if e["status"] == "D":
        order["orphaned"].append({**base, "why": "the file it cites was deleted"}); continue
    if e["status"] == "R":
        order["renamed"].append({**base, "to": e.get("to"), "similarity": e.get("similarity"),
            "why": "file renamed, contents identical: re-anchor ev only" if e.get("similarity") == 100
                   else "file renamed and edited: re-read"}); continue
    if c["owner"] in fx_ids:
        order["formulas"].append({**base, "k": "formula",
            "why": "a source or config file it models changed"}); continue
    if e["status"] == "A":
        order["reread"].append({**base, "why": "the file it cites is new to this build"}); continue
    if c["lo"] is None:
        order["reread"].append({**base, "why": "the file changed and the node cites no line range"}); continue
    hs = hunks_for(c["file"])
    if hs is None:
        order["reread"].append({**base, "why": "the file changed (no hunk detail available)"}); continue
    delta, overlap = 0, False
    for h in hs:
        h_lo, h_hi = h["oldStart"], h["oldStart"] + max(h["oldLen"], 1) - 1
        if h["oldLen"] == 0:
            if c["lo"] <= h_lo < c["hi"]: overlap = True
            elif h_lo < c["lo"]: delta += h["newLen"]
        elif h_hi < c["lo"]:
            delta += h["newLen"] - h["oldLen"]
        elif h_lo <= c["hi"]:
            overlap = True
    if overlap:
        order["reread"].append({**base, "why": "an edit lands inside its line range"})
    elif delta:
        order["drift"].append({**base, "delta": delta,
            "suggest": str(c["lo"] + delta) if c["lo"] == c["hi"] else f"{c['lo']+delta}-{c['hi']+delta}",
            "why": "edits above it only: shift ev, no re-read"})

# Changed files no node cites: new entry points, new external calls, deleted dead code.
cited_files = {c["file"] for c in cites}
SKIP_NAME = re.compile(r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock)$")
SKIP_EXT = re.compile(r"\.(md|txt|png|jpg|jpeg|svg|gif|ico|lock)$", re.I)
# Tests, fixtures and vendored trees rarely become nodes; they would otherwise sit in `scan` forever.
SKIP_DIR = re.compile(r"(^|/)(test|tests|__tests__|spec|fixtures|testdata|node_modules|vendor|dist|build|\.github)/", re.I)
SKIP_FILE = re.compile(r"(\.(test|spec)\.[a-z]+|_test\.go|Tests?\.(java|kt|cs))$", re.I)
for rel, e in changed.items():
    if rel in cited_files or SKIP_NAME.search(rel) or SKIP_EXT.search(rel) \
       or SKIP_DIR.search(rel) or SKIP_FILE.search(rel): continue
    order["scan"].append({"file": rel, "status": e["status"], "to": e.get("to"),
        "why": "new file: does it add a node, a call or a branch?" if e["status"] == "A"
               else "deleted file no node cited: confirm nothing on the map depended on it"
               if e["status"] == "D"
               else "changed file no node cites: was it missed in the first read?"})

order["counts"] = {k: len(order[k]) for k in ("reread", "drift", "orphaned", "renamed", "formulas", "scan")}
order["counts"].update(changedFiles=len(changed), nodes=len(all_ids),
                       nodesWithoutEvidence=len(all_ids - {c["owner"] for c in cites}),
                       nodesUntouched=len(all_ids - touched))

# ---------- 4. report ----------
if a.out:
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    open(a.out, "w", encoding="utf-8").write(json.dumps(order, indent=1) + "\n")
print(json.dumps(order, indent=1))

c = order["counts"]
if force_full:
    die("\nRESULT: FULL REBUILD — " + "; ".join(f"{r['name']}: {r['why']}"
                                                for r in repo_report if not r["ok"]), 1)
if order.get("template_changed"):
    print("\nNOTE: the template changed since this build; rebuild the page from the current "
          "template (the data still stands).", file=sys.stderr)
if not c["changedFiles"]:
    die("\nRESULT: CURRENT — no repo moved since " + (state.get("built") or "the last build"), 2)
print(f"\nRESULT: REFRESH — {c['changedFiles']} changed file(s): re-read {c['reread']}, "
      f"shift {c['drift']}, orphaned {c['orphaned']}, renamed {c['renamed']}, "
      f"formulas {c['formulas']}, scan {c['scan']}; "
      f"{c['nodesUntouched']}/{c['nodes']} nodes untouched", file=sys.stderr)
