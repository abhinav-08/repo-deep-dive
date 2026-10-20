// Checks a built service map in headless Chromium and saves screenshots to look at.
// usage: NODE_PATH=$(npm root -g) node check_svcmap.js PAGE.html [SHOT_DIR]
// Exit code 1 on hard failures. "warn_*" lists are for review, not failures.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const file = path.resolve(process.argv[2]), out = path.resolve(process.argv[3] || 'svcmap-shots');
  fs.mkdirSync(out, { recursive: true });
  const exe = ['/opt/pw-browsers/chromium'].find(p => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) errs.push('console: ' + m.text()); });  // offline fonts are not a page bug
  await page.goto('file://' + file); await page.waitForTimeout(800);
  const shot = async (name) => page.locator('#stage').screenshot({ path: path.join(out, name) });
  const R = { errors: errs };

  // 1. data integrity
  Object.assign(R, await page.evaluate(async () => {
    const ids = [], dup = [], badKind = [], missingD = [], orphanIn = [], missingFx = [], brx = [], longT = [];
    const kinds = new Set(['system', 'service', 'stage', 'step', 'decision', 'store', 'external', 'case']);
    (function w(n) { if (ids.includes(n.id)) dup.push(n.id); ids.push(n.id); (n.kids || []).forEach(w); })(N);
    Object.values(byId).forEach(n => {
      if (!kinds.has(n.k)) badKind.push(n.id + ':' + n.k);
      [...(n.in || []), ...(n.out || [])].forEach(d => { if (!D[d]) missingD.push(n.id + ' -> ' + d); });
      (n.in || []).forEach(d => { if (!(producers[d] || []).some(p => p !== n.id)) orphanIn.push(n.id + ' <- ' + d); });
      (n.fx || []).forEach(f => { if (!FX[f]) missingFx.push(n.id + ':' + f); });
      if (n.br && n.brx && n.brx.length !== n.br.length) brx.push(n.id);
      const lim = n.k === 'decision' ? 34 : n.k === 'case' ? 30 : 28;
      if (String(n.t).length > lim) longT.push(n.id + ' (' + String(n.t).length + ')');
    });
    const unlinked = Object.keys(D).filter(d => !(consumers[d] || []).length && !(producers[d] || []).length);
    const extraOrphans = Object.keys(EXTRA).filter(id => !byId[id]);
    const fxErr = [];
    for (const id of Object.keys(FX)) {
      try {
        const f = FX[id], v = Object.fromEntries(f.inp.map(i => [i.id, i.v]));
        const r = await Promise.resolve(f.run(v)); const rows = (r && r.rows) || [];
        if (!rows.length && !(r && (r.svg || r.html))) fxErr.push(id + ': empty result');
        const e = rows.find(x => x[0] === 'Error'); if (e) fxErr.push(id + ': ' + e[1]);
        rows.forEach(x => { if (/NaN|undefined/.test(String(x[1]))) fxErr.push(id + ': "' + x[0] + '" = ' + x[1]); });
      } catch (e) { fxErr.push(id + ': ' + e.message); }
    }
    return { nodes: ids.length, decisions: Object.values(byId).filter(n => n.k === 'decision').length,
      dataItems: Object.keys(D).length, formulas: Object.keys(FX).length,
      dup, badKind, missingD, extraOrphans, missingFx, brxLenMismatch: brx, fxErr,
      warn_inputsWithoutProducer: orphanIn, warn_unlinkedData: unlinked, warn_longTitles: longT };
  }));

  // 2. worst-case layout: everything open, including every decision's cases
  R.layout = await page.evaluate(() => {
    Object.keys(byId).forEach(i => st.open.add(i)); layout();
    const cols = {}; Object.entries(POS).forEach(([id, p]) => { (cols[p.x] = cols[p.x] || []).push({ id, ...p }); });
    const overlaps = []; Object.values(cols).forEach(c => { c.sort((a, b) => a.y - b.y);
      for (let i = 1; i < c.length; i++) if (c[i].y < c[i - 1].y + c[i - 1].h - 0.01) overlaps.push(c[i - 1].id + ' / ' + c[i].id); });
    return { visible: Object.keys(POS).length, overlaps };
  });
  await page.evaluate(() => { render(); fit(); }); await page.waitForTimeout(500);
  await shot('1-all-open.png');

  // 3. diamond hit test: centre selects, bounding-box corner does not
  const dec = await page.evaluate(() => { const d = Object.values(byId).find(n => n.k === 'decision'); return d && d.id; });
  if (dec) {
    await page.evaluate((id) => { select(N.id, false); st.k = 1; const p = POS[id], r = stageEl.getBoundingClientRect();
      st.tx = r.width * 0.42 - (p.x + 120); st.ty = r.height * 0.45 - (p.y + p.h / 2); applyTx(); }, dec);
    await page.waitForTimeout(400);
    const box = await page.locator(`.nd[data-id="${dec}"]`).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(400);
    const a = await page.evaluate(() => st.sel);
    await page.evaluate(() => { select(N.id, false); }); await page.waitForTimeout(400);
    await page.mouse.click(box.x + 8, box.y + 8); await page.waitForTimeout(400);
    const b = await page.evaluate(() => st.sel);
    R.diamondClick = { node: dec, centreSelects: a === dec, cornerIgnored: b !== dec };
    await page.evaluate((id) => select(id, false), dec); await page.waitForTimeout(400);
    await shot('2-decision-selected.png');
  }

  // 4. wheel must not zoom; double-click zooms in; buttons work
  const k0 = await page.evaluate(() => st.k);
  const sb = await page.locator('#stage').boundingBox();
  await page.mouse.move(sb.x + 60, sb.y + 60); await page.mouse.wheel(0, -400); await page.waitForTimeout(300);
  const k1 = await page.evaluate(() => st.k);
  await page.mouse.dblclick(sb.x + 60, sb.y + sb.height - 80); await page.waitForTimeout(600);
  const k2 = await page.evaluate(() => st.k);
  await page.click('#zFit'); await page.waitForTimeout(300);
  R.zoom = { wheelIgnored: k1 === k0, dblclickZooms: k2 > k1 * 1.5 || k2 >= 2.2 - 1e-9, readout: await page.textContent('#zReset') };

  // 5. richest node in the inspector (ext + fx + logic), light and dark
  const rich = await page.evaluate(() => { const sc = n => (n.ext ? 2 : 0) + (n.fx ? 2 : 0) + (n.logic ? 1 : 0) + (n.what ? 1 : 0);
    return Object.values(byId).filter(n => n.k !== 'case').sort((a, b) => sc(b) - sc(a))[0].id; });
  await page.evaluate((id) => { select(id, true); }, rich); await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, '3-inspector-light.png'), fullPage: false });
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, '4-inspector-dark.png'), fullPage: false });
  await page.emulateMedia({ colorScheme: 'light' });

  // 6. formulas and lineage tabs
  if (await page.isVisible('#vFx')) { await page.click('#vFx'); await page.waitForTimeout(500);
    R.formulasTab = await page.evaluate(() => ({ cards: document.querySelectorAll('.fxcard').length,
      errorRows: [...document.querySelectorAll('table.fxout th')].filter(th => th.textContent === 'Error').length }));
    await page.screenshot({ path: path.join(out, '5-formulas.png'), fullPage: false }); }
  if (await page.isVisible('#vLin')) { await page.click('#vLin'); await page.waitForTimeout(300);
    R.lineageRows = await page.evaluate(() => document.querySelectorAll('.lrow').length - 1); }
  await page.click('#vTree'); await page.waitForTimeout(300);

  // 7. phone width: no horizontal page scroll
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  R.phoneNoHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await page.screenshot({ path: path.join(out, '6-phone.png'), fullPage: false });

  const hard = errs.length || R.dup.length || R.badKind.length || R.missingD.length || R.extraOrphans.length || R.missingFx.length ||
    R.brxLenMismatch.length || R.fxErr.length || R.layout.overlaps.length || (R.diamondClick && !(R.diamondClick.centreSelects && R.diamondClick.cornerIgnored)) ||
    !R.zoom.wheelIgnored || !R.zoom.dblclickZooms || (R.formulasTab && R.formulasTab.errorRows) || !R.phoneNoHScroll;
  console.log(JSON.stringify(R, null, 1));
  console.log(hard ? 'RESULT: FAIL' : 'RESULT: PASS', '| screenshots in', out);
  await browser.close(); process.exit(hard ? 1 : 0);
})();
