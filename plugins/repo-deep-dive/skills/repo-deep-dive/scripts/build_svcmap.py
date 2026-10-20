#!/usr/bin/env python3
"""Assemble a service map page from the template and one or more data files.

usage: python3 build_svcmap.py TEMPLATE OUT.html DATA.js [MORE.js ...] --title "X Service Map" [--standalone OUT_OFFLINE.html]

OUT.html is the artifact page (no <html>/<body> skeleton; the host adds it).
--standalone also writes a complete offline document for download."""
import argparse, html, os, re, shutil, subprocess, sys, tempfile

ap = argparse.ArgumentParser()
ap.add_argument("template"); ap.add_argument("out"); ap.add_argument("data", nargs="+")
ap.add_argument("--title", required=True); ap.add_argument("--standalone")
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
