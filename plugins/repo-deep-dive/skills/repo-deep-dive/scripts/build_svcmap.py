#!/usr/bin/env python3
"""Assemble a service map page from the template and one or more data files.

usage: python3 build_svcmap.py TEMPLATE OUT.html DATA.js [MORE.js ...] --title "X Service Map"
         [--standalone OUT_OFFLINE.html] [--state state.json] [--repo NAME=PATH ...]

OUT.html is the artifact page (no <html>/<body> skeleton; the host adds it).
--standalone also writes a complete offline document for download.
--state records what this map was built from, so a later run can refresh only
what changed; svcmap_diff.js reads it. Pass --repo once per repo read."""
import argparse, hashlib, html, json, os, re, shutil, subprocess, sys, tempfile, time

ap = argparse.ArgumentParser()
ap.add_argument("template"); ap.add_argument("out"); ap.add_argument("data", nargs="+")
ap.add_argument("--title", required=True); ap.add_argument("--standalone")
ap.add_argument("--state", help="write this incremental state file (enables refreshes)")
ap.add_argument("--repo", action="append", default=[], metavar="NAME=PATH",
                help="a repo this map was read from; repeatable. PATH defaults to NAME.")
a = ap.parse_args()

t = open(a.template, encoding="utf-8").read()
if t.count("/*__DATA__*/") != 1 or t.count("__TITLE__") != 1:
    sys.exit("template markers /*__DATA__*/ and __TITLE__ must each appear once")
data = "\n".join(open(p, encoding="utf-8").read() for p in a.data)
for name in ("CFG", "D", "N", "EXTRA", "FX"):
    if not re.search(r"\b(const|let|var)\s+" + name + r"\s*=", data):
        sys.exit(f"data block must declare {name} (use {{}} when empty)")
for helper in ("L", "esc", "fmt", "clamp", "bars", "plot"):   # top-level only; shadowing inside functions is fine
    if re.search(r"^(const|let|var|function)\s+" + helper + r"\b", data, re.M):
        sys.exit(f"data block redeclares the template helper {helper} at top level; remove it")
if "</script" in data.lower():
    sys.exit("data contains </script>; write it as <\\/script> inside strings")

page = t.replace("__TITLE__", html.escape(a.title)).replace("/*__DATA__*/", data)

# JS syntax check when node is available
script = page[page.index("<script>") + 8: page.rindex("</script>")]
if shutil.which("node"):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(script); tmp = f.name
    r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
    os.unlink(tmp)
    if r.returncode:
        sys.exit("JS syntax error (line numbers count from the page's <script>):\n" + r.stderr[:1500])
    print("syntax ok")

os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
open(a.out, "w", encoding="utf-8").write(page)
print("page", a.out, len(page), "bytes")

if a.standalone:
    head, body = page.split("</style>", 1)
    head = re.sub(r"<title>.*?</title>\s*", "", head, count=1, flags=re.S)
    head = re.sub(r'<meta name="claude:viewport-fit-sides"[^>]*>\s*', "", head, count=1)
    doc = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
           '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
           f"<title>{html.escape(a.title)}</title>\n" + head + "</style>\n</head>\n<body>\n"
           + body.strip() + "\n</body>\n</html>\n")
    os.makedirs(os.path.dirname(os.path.abspath(a.standalone)), exist_ok=True)
    open(a.standalone, "w", encoding="utf-8").write(doc)
    print("standalone", a.standalone, len(doc), "bytes")

# ---- incremental state: what this build saw, so the next run can diff against it ----
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

if a.state:
    sdir = os.path.dirname(os.path.abspath(a.state)) or "."
    repos = []
    for spec in a.repo:
        name, _, root = spec.partition("=")
        root = root or name
        head = git(root, "rev-parse", "HEAD")
        repos.append({"name": name, "path": os.path.relpath(os.path.abspath(root), sdir),
                      "head": head, "branch": git(root, "rev-parse", "--abbrev-ref", "HEAD"),
                      "dirty": bool(git(root, "status", "--porcelain")) if head else None})
    if not repos:
        print("warning: --state without --repo; refreshes will have nothing to diff", file=sys.stderr)

    # Hash every file the data cites in `ev`, so a repo without git can still be refreshed.
    cited, missing = {}, 0
    for m in re.finditer(r'\bev\s*:\s*"([^"]+)"', data):
        for ref in m.group(1).split(","):
            rel = re.sub(r":\d+(?:\s*-\s*\d+)?$", "", ref.strip())
            if not rel or rel in cited: continue
            for r in repos:
                if rel == r["name"] or rel.startswith(r["name"] + "/"):
                    abs_p = os.path.join(sdir, r["path"], rel[len(r["name"]) + 1:])
                    if os.path.isfile(abs_p): cited[rel] = sha256(abs_p)
                    else: missing += 1
                    break
            else:
                missing += 1

    os.makedirs(sdir, exist_ok=True)
    open(a.state, "w", encoding="utf-8").write(json.dumps({
        "version": 1, "slug": os.path.basename(a.out).replace("-service-map.html", ""),
        "title": a.title, "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "template_sha256": sha256(a.template),
        "data_files": [os.path.relpath(os.path.abspath(p), sdir) for p in a.data],
        "repos": repos, "files": cited,
    }, indent=1) + "\n")
    print("state", a.state, f"{len(repos)} repo(s), {len(cited)} cited file(s)"
          + (f", {missing} ev path(s) not found on disk" if missing else ""))
