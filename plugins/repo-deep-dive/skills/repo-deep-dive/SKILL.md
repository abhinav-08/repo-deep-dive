---
name: repo-deep-dive
description: Turn a codebase into an interactive service map with decision diamonds, external calls, live formula calculators and data lineage, plus an optional architecture Q&A pack. Re-run it after code changes and it refreshes only what moved.
---

# Repo deep dive

Turns one or more code repositories into:

1. **Service map** (default). One interactive HTML page: a horizontal, collapsible tree with the system on the left and services, stages and steps opening to the right. Decisions are diamonds that open into their cases. Clicking a node opens an inspector with what happens there, the if/else in code terms, external-call cards (Elasticsearch, SQL, Kafka, Redis, HTTP, ...), live formula calculators, and what the node consumes and produces with links to producers and consumers. It also has a Formulas tab and a Data lineage table. It is delivered as one offline HTML file, and as a hosted page where the environment can publish one.
2. **Architecture Q&A pack** (when the user asks for it). A Markdown pack grounded in the code, five parts per focus area. It serves onboarding, design review, handover and interview prep alike: what the system does today, the alternatives and why one wins, the cross-questions it has to survive, and the weak spots worth owning.

Aim for production depth: 150 to 250 nodes, every branch point as a decision, a calculator for every formula a reader would reason about, and file:line evidence on every node.

The UI is already built and tested, and lives in this skill's folder. For each repo you only write data.
- `assets/svcmap-template.html`: the page. Never edit it per repo.
- `assets/sample-data.js`: a small fictional example that uses every field.
- `scripts/build_svcmap.py`: merges the template and your data into the page and an offline copy, and records what the build saw.
- `scripts/check_svcmap.js`: loads the page in headless Chromium, checks it and takes screenshots.
- `scripts/svcmap_diff.js`: works out what a built map needs re-read after the repos moved on.

"This skill's folder" is `${CLAUDE_SKILL_DIR}` in Claude Code. Elsewhere it is the directory this SKILL.md was loaded from.

## Step 0: Mode — full build or refresh

A map that already exists is not rebuilt from scratch. Before reading any code, look for `state.json` in the work folder (`service-maps/<slug>/`, or wherever the user keeps the map).

- **No work folder or no `state.json`:** full build. Go to Step 1.
- **The user said `full`, or asked to start over:** full build. Keep the old `facts.md` and data files until the new ones pass the checker.
- **Otherwise:** refresh. Don't guess the scope — the diff computes it:

```bash
cd service-maps/<slug>
node svcmap_diff.js --state state.json --out out/work-order.json cfg.js data.js nodes-*.js extra.js fx.js
```

Act on the exit code, not just the output:

- **2, current.** No repo moved. Say so, point at the existing map, and stop. Don't rebuild.
- **1, full rebuild needed.** The repo path is gone, the recorded commit isn't in the repo (force-push or shallow clone), or there's no state to diff against. Say which, then go to Step 1.
- **0, refresh.** The work order names exactly what to do. Work the lists in this order:

| List | What it means | What to do |
|---|---|---|
| `reread` | An edit lands inside the node's cited line range. | Re-read those lines. Update the node, its `ext`, `logic`, `what` and `fx`, and its `ev` range. |
| `formulas` | A source or config file an `FX` entry models changed. | Re-check every input default against the new config, and the `run` body if the math itself moved. |
| `renamed` | The cited file moved. `similarity: 100` means the contents are identical. | At 100, rewrite the `ev` path and nothing else. Below 100, treat it as `reread` as well. |
| `orphaned` | The cited file was deleted. | Find where the behavior went. Moved: re-anchor `ev`. Gone: delete the node and any `D` entries only it used. Either way it's a finding. |
| `drift` | Only lines *above* the node changed. | Apply the `suggest` range to `ev`. Don't re-read: nothing inside the node changed. |
| `scan` | A changed or new file that no node cites. | Read it. A new entry point, external call or branch means new nodes. A deleted one means the first read cited nothing there, which is itself worth recording. |

Rules for a refresh:

1. **Only touch what the work order names.** A node in none of the lists keeps its text, its `ev` and its confidence tag. Not re-reading it is the point.
2. **`drift` is not a re-read.** Shift the line numbers and move on.
3. **Re-verify `Inferred` nodes next to a `reread`.** An inference drawn from code that just changed is the first thing to go stale.
4. **Append to `facts.md`; don't rewrite it.** Mark superseded lines instead of deleting them, so the history survives.
5. **`template_changed` in the work order** means rebuild the page from the current template. The data still stands.
6. **If the work order touches more than about half the nodes, say so and offer a full build.** Past that the refresh has stopped being cheaper, and a fresh read is more likely to be coherent.

A refresh still ends with Step 4 (build and check) and Step 5 (deliver). Steps 2 and 3 apply only to the files the work order named.

## Step 1: Scope

- **Find the repos.** Read them from the workspace. For a GitHub URL, clone it (shallow) if the environment allows; otherwise ask the user for the code.
- **Scope tightly.** Start from the repos the user named and follow only the calls they make into other repos. Don't scan every repo in the workspace. Read the workspace and per-repo CLAUDE.md and README files first when they exist.
- **Deliverables.** Build the map by default. Add the Q&A pack when the user asks for it, whether for onboarding, a design review, a handover or interview prep. The pack needs a list of focus areas (a topic list, a job description, a review agenda); if it isn't in the conversation, ask for it once.
- If several repos are named and the entry point is unclear, ask one question. Otherwise start working in the same reply.
- Make a task list. Full build: read code, fact register, map data, build and check, deliver, Q&A pack (if wanted), verify. Refresh: run the diff, work the lists, update facts, rebuild and check, write `CHANGES.md`, deliver.
- **Record the repos for later refreshes.** Note each repo's name and its path relative to the work folder; Step 4 passes them to the build as `--repo <name>=<path>`.

## Step 2: Read the code into a fact register

Keep `facts.md` in the work folder, one tagged and sourced line per fact:
`[Code] OrderService.java:88-104 placeOrder: retries the payment call only on HTTP 503`
Every map node and every pack claim comes from this file. If the session is interrupted, you can carry on from it.

**On a refresh, read only the files the work order named** — its `reread`, `formulas`, `renamed` (below 100) and `scan` entries. The order below is for a first pass.

Read in this order:
1. Entry points: HTTP routes, consumers, schedulers, CLIs.
2. The main request path, end to end.
3. Each branch point.
4. Every external call: the exact request body, timeout, retries and cache.
5. Config per environment: helm or k8s values, application-prod.yml, env files.
6. Feature flags and experiments.
7. Caches and their keys.
8. Background jobs and producers.

Rules learned the hard way:
1. **Defined is not wired.** Before saying a feature runs, find its call site on the live path. Search for other callers before saying "never". A fully built reranker that nothing attaches to the query is a common example.
2. **Production config beats code defaults.** When a value is unset, name the library default and where it comes from. If it comes from memory, tag it [Inferred].
3. **Check units and scales:** ms vs s, TTL multipliers, per-shard vs total, bytes vs KB. Two caches of the same data with TTLs in different units is a common bug.
4. **Library semantics decide behavior.** Circuit-breaker error filters, retry-on-timeout, client maxRetries and Kafka error handlers are examples. When a claim depends on one, read the library source in node_modules or the jar sources. Otherwise tag it [Inferred] and list it to verify.
5. **Flags:** record each flag's name, its default and what each arm changes.
6. **What the repo cannot tell you** goes in as [Unknown], with the read-only command that would fetch it. That covers cluster and index settings, mappings, shard and partition counts, runtime pool sizes and live traffic.
7. **Dead code and unused wiring are findings.** Examples: `if (false && …)` blocks, beans that are defined but never injected. Mark them on the map with `warn` and include them in the pack.
8. **Never invent a file:line.** If you did not read it, the confidence tag says so.

Confidence tags go on nodes (`c`), call cards (`conf`) and calculators (`conf`):
- `Code`: read in the source.
- `Docs`: vendor documentation, e.g. "ES docs".
- `Doc`: team notes.
- `Inferred`: derived; verify before quoting.
- `Model`: a simplified model of library behavior.
- `Unknown`: not in the repos.

Combine them when a claim is mixed, e.g. "Code + Inferred".

## Step 3: Model the map

**Tree shape**
- **Root (`k:"system"`):** the platform. Its `d` is a one-paragraph overview.
- **Services (`k:"service"`):** one per deployable. Add `calls: [[target, "endpoint, timeout, retries"]]`.
- **External systems and stores:** systems you call but did not read are `k:"external"`. Databases, caches, indexes and topics are `k:"store"`.
- **Stages (`k:"stage"`):** 4 to 10 phases per service, in execution order.
- **Steps (`k:"step"`):** a method, or a few methods.
- **Decisions (`k:"decision"`):** a branch point with `br: [[condition as written in code, outcome]]`. Case nodes are generated from `br`, so don't write them as kids.
- **Text length:**
  - Titles: 28 characters or fewer (longer ones are cut).
  - Case conditions: 30 or fewer.
  - Decision titles: 34 or fewer (they wrap to two lines).
  - Subtitles: 45 or fewer. Longer text goes in `d`, `what` or `brx`.
- **Ids:** short, stable and prefixed per service (`api_`, `wrk_`). Case ids are `<id>__c<i>`. Ids are the refresh's handle on a node, so never renumber one that still describes the same code.
- **Evidence paths (`ev`):** repo-relative, with line numbers — `<repo>/<path>:<line>` or `<repo>/<path>:<from>-<to>`, for example `checkout-api/src/main/java/com/shop/cart/CartRepository.java:41`. Several references may be comma-separated. A refresh maps the git diff onto nodes through these, so a bare filename costs you the incremental path; the checker lists offenders under `warn_evNotRepoRelative`. Put `ev` on `FX` entries too, pointing at the source or config file whose numbers the calculator models.

**Data and lineage**
- Put every value that crosses a step boundary in `D`: requests, flags, intermediate objects, cache keys, query bodies, responses and events. Give each `s` a realistic shape with real field names.
- Set `in` and `out` on nodes. Producers, consumers, flow lines and the lineage table are all derived from them.
- Every `in` needs a producer. The incoming request comes from a client or edge node.

**Leaf detail (EXTRA): the part that makes the map worth opening**
- `what`: 2 to 5 plain sentences in execution order, with real numbers.
- `logic`: the code simplified. Keep the real names and the if/else structure, and use `//` comments for intent. Wrap it in L`...` so backslashes survive.
- `ext`: one card per external call. Include the real request body trimmed to what matters, the response fields actually used, the timeout and retries, and any cache.
- `brx`: one line per case saying what happens next.
- `fx`: a calculator for anything numeric a reader would reason about.
  - What qualifies:
    - scoring and boosting functions, minimum_should_match;
    - decay and saturation curves, similarity thresholds;
    - retries, backoff and timeouts (draw them with `bars`), circuit-breaker windows;
    - paging and window limits, cache keys and TTLs, rate limits;
    - bulk and batch sizing, shard or partition math;
    - bloom filters, string similarity, id hashing.
  - Default each input to the real config value.
  - Each run returns:
    - `rows`, tagged ok, warn or bad;
    - an svg where the shape matters (`plot` or `bars`);
    - a `trace` for step-by-step logic;
    - a `note` saying what the model leaves out.
- `warn`: known issues and risks, one sentence each.

**First view and footer.** `CFG.open` and `CFG.sel` should land the first view on a rich leaf. `CFG.foot` names the repos read, what isn't in them, and the confidence tags.

### Data contract

The data files must declare `CFG`, `D`, `N`, `EXTRA` and `FX`; use `{}` when one is empty.

| Object | Fields | Notes |
|---|---|---|
| `CFG` | `title`, `kicker`, `find`, `key`, `open[]`, `sel`, `lede?`, `foot?` | `lede` and `foot` accept simple HTML. `key` namespaces the remembered selection. |
| `D[key]` | `n`, `d`, `s?` | Name, what it is, and a shape or example (shown as code). |
| node in `N` | `id`, `k`, `t`, `s?`, `d?`, `kids?`, `in?`, `out?`, `calls?`, `br?`, `ev?`, `c?`, `warn?`, `uses?` | `k` is one of system, service, stage, step, decision, store, external. `ev` holds repo-relative file:line evidence. `uses` says how the output is used. |
| `EXTRA[id]` | `what[]`, `logic`, `ext`, `fx[]`, `brx[]`, `warn`, `uses`, `ev`, `c`, `patch{}` | Merged into the node at load. `patch` overrides any base field. |
| `ext` (object or array) | `sys`, `tag`, `cluster`, `target`, `api`, `when`, `timeout`, `cache`, `req`, `resp`, `notes`, `conf` | `tag` is the pill text (ES, SQL, KAFKA, REDIS, HTTP). |
| `FX[id]` | `t`, `conf`, `d`, `ev?`, `inp[]`, `run(v)` | Input fields:<br>• `id`, `type`, `label`, `v`<br>• `type` is text, num, range, check or select<br>• `min`, `max`, `step` for ranges<br>• `opts: [[value, label]]` for selects<br><br>`run` returns `{rows: [[label, value, "ok"/"warn"/"bad"/"mono"]], svg?, html?, trace?[], note?}` and may be async. |

The template provides these helpers. Don't redeclare them at the top level:
- `L` (String.raw)
- `esc`
- `fmt(x, digits)`
- `clamp`
- `bars(segs, total, unit, aria)`, where segs are `{a, b, label, cls: good|bad|wait}`
- `plot({f, lo, hi, x, guides: [{x, label}], ylo, yhi, xl, aria})`

You can split large data across files, for example cfg.js, data.js, nodes-<svc>.js, extra.js and fx.js; the build concatenates them in order. To split the tree, declare subtrees as consts and assemble `const N = {id: "root", ..., kids: [EDGE, API, WRK]}` in the last nodes file.

## Step 4: Build, check, look

1. **Copy the skill's files into a work folder.** Use `service-maps/<slug>/` in the workspace unless the user names another place. Run the later commands from the work folder. On a refresh the folder already exists; re-copy the files so a skill update takes effect.

```bash
SKILL="${CLAUDE_SKILL_DIR}"; WORK=service-maps/<slug>
mkdir -p "$WORK" && cp "$SKILL"/assets/svcmap-template.html "$SKILL"/assets/sample-data.js "$SKILL"/scripts/build_svcmap.py "$SKILL"/scripts/check_svcmap.js "$SKILL"/scripts/svcmap_diff.js "$WORK"/ && cd "$WORK"
```

2. **Write the data files.** Start from sample-data.js, which uses every field.
3. **Build:**

```bash
python3 build_svcmap.py svcmap-template.html out/<slug>-service-map.html cfg.js data.js ... \
  --title "<Name> Service Map" --standalone out/download/<slug>-service-map.html \
  --state state.json --repo <name>=<path-to-repo> [--repo ...]
```

   `--state` and `--repo` are what make the next run incremental: the build records each repo's commit, the template's hash and a hash of every file the data cites in `ev`. Pass `--repo` once per repo, with the path relative to the work folder (`--repo checkout-api=../../checkout-api`). Always pass them — a map built without `--state` can only ever be rebuilt in full. The build prints how many `ev` paths it could not find on disk; anything above zero means a wrong path, so fix it now rather than discovering it at the next refresh.

   The build refuses data that:
   - is missing CFG, D, N, EXTRA or FX;
   - redeclares a helper at the top level;
   - contains `</script>`.

   It also runs `node --check` when node is available.
4. **Check:**
   `NODE_PATH=$(npm root -g) node check_svcmap.js out/<slug>-service-map.html out/shots`
   - It needs Playwright and Chromium. If they're missing, run `npm i -g playwright && npx playwright install chromium` once.
   - Fix every hard failure.
   - Review the warn lists:
     - an input with no producer, other than the entry request, means a missing node or data link;
     - long titles get cut;
     - `warn_evNotRepoRelative` lists evidence a refresh won't be able to map; fix each one.
5. **Look at every screenshot** in out/shots: everything open, decision selected, inspector in light and dark, formulas, phone width.
6. **Re-check five random leaves** against the source before delivering. On a refresh, pick them from the nodes you just changed.
7. **Confirm the refresh landed.** Re-run `node svcmap_diff.js --state state.json cfg.js data.js ...` after the build. It should exit 2 (current), or exit 0 listing only `scan` files you deliberately chose not to map. Anything else still listed is something you missed. Give a dismissed `scan` file a line in `CHANGES.md` saying why, or it will resurface at every future refresh — and if it is dead code or unwired config, it belongs on the map as a `warn` node instead.

## Step 5: Deliver

- **Offline map.** `out/download/<slug>-service-map.html` is a complete page that works without a network. Open it in the browser (`open` on macOS, `xdg-open` on Linux) or hand it to the user as a file.
- **Hosted page.** If the environment can publish HTML pages (for example artifacts on claude.ai), publish `out/<slug>-service-map.html`. It is the same map without the `<html>`/`<body>` skeleton.
- **Change log (refresh only).** Prepend a dated section to `CHANGES.md` in the work folder, newest first, so the file reads as the map's history:

```text
## 2026-10-26 · checkout-api a1b2c3d..f9e8d7c (14 commits)

ADDED    api_rerank  step      Rerank results before paging
UPDATED  api_pay     ext       timeout 2 s → 5 s per try
UPDATED  retry       formula   backoff 200 ms → 500 ms (application-prod.yml:15)
MOVED    api_cartok  ev        CheckoutService.java → CheckoutFlow.java
REMOVED  api_pub               OrderEvents.java deleted

FINDINGS
  + [Code] 3 tries × 5 s now exceeds the 12 s load-balancer idle timeout
  - resolved: idempotency key added, PaymentClient.java:41

SCANNED  Reranker.java — built, but nothing calls it yet [Code]
```

  One line per change, naming the node id and what moved. Leave `drift` out: a shifted line number is noise, not a change. Under `FINDINGS`, `+` is new and `-` is resolved; carry both into the Q&A pack's findings register if that pack exists. Name the commit range so a reader can check the diff themselves.
- **Reply in a few sentences:** where the files are, what the map covers, the top findings, and what is tagged to verify. Don't recap the steps. On a refresh, lead with what changed in the system, not with how many nodes you touched.

## Step 6: Architecture Q&A pack (when requested)

Write `<slug>-architecture-qa-pack.md` in the work folder as polished Markdown. The reader is someone who has to explain or defend this system — in onboarding, a design review, a handover or an interview. Structure:

1. **Header.** Title, the repos it was built from, what the pack is for, and the confidence labels [Code], [Inferred] and [Unknown].
2. **Confidentiality rule.** Describe the architecture, not the internals: no hostnames, model ids, internal service names, or vendor details that aren't public.
3. **§0 What the repos don't tell you.** For each store, the read-only commands that fetch the missing facts (e.g. `_cat/indices`, `_mapping`, `\d+ table`, `kafka-topics --describe`, `INFO`). Add a table pairing each question the user will be asked with why it gets asked.
4. **§1 Your system on one whiteboard.** An ASCII diagram with real numbers (pods, timeouts, shards, TTLs), simple enough for the user to redraw from memory in three minutes.
5. **One section per focus area.** Each section has five parts:
   1. What your system does today, with file:line references.
   2. The alternatives and why one wins, as a table of approach, pros and cons.
   3. Cross-questions with model answers.
   4. What to avoid claiming, and why it doesn't hold up.
   5. Weak spots to own: findings framed as "a risk I identified and how I'd fix it".
6. **Diagnosis drills built from their system.** Each drill goes from symptom to ranked hypotheses, to what to check, to the fix.
7. **Findings register.** Columns: #, finding, where, severity, confidence. Never present an [Inferred] item as a confirmed bug.
8. **Validation questions.** Any validation questions supplied by the user, answered with pointers to the evidence above.
9. **Study plan.** A day-by-day plan for working through the pack.

When the user then asks to be taught a topic, use the same five-part shape: core concepts; alternatives and why one is chosen; cross-questions; what to avoid; ties to their own infrastructure. Then offer to quiz them.

## Writing rules for everything produced

- Keep it plain and specific, with no filler.
- Put a confidence label on anything not read directly in code.
- Give numbers with their units.
- Treat the map and the pack as sensitive as the code itself: they describe its internals.

## Already solved in the template (don't reintroduce)

- **No wheel zoom.** By design the mouse wheel scrolls the page. Zoom is −, +, 100% (reset), Fit, and double-click (Shift+double-click zooms out).
- **Custom double-click detection.** Double-click is detected from pointer events, because a click re-renders the node and breaks the native dblclick.
- **No `stage` or `case` class names.** They collide with the legend markers, which is why the template uses `.mapstage` and `.casebtn`.
- **No `data-sel` on containers.** Click delegation selects anything with `[data-sel]`.
- **Dark-mode contrast.** Text on accent fills uses `--onaccent`.
- **`fmt` keeps integer zeros.** An earlier version turned 540 into 54.
- **Diamond decisions.** Decisions are 96 px diamonds, the layout handles mixed node heights, and only clicks inside the diamond select it.
- **Changing the template.** For a change every map should get, edit `assets/svcmap-template.html`, then rebuild the sample data and rerun the checker before using it.
