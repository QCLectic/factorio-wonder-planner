/* UI: form, solve, flow view (SVG), side panel. */
(function () {
  'use strict';
  const data = window.FACTORIO_DATA;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  // Planet colors for the stripe on group boxes. Index follows FPGroups.planetNames.
  const planetHue = (p) => (FPGroups.planetNames(data).indexOf(p) * 58 + 100) % 360;

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const pretty = (s) => s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const unitName = () => ({ 1: '/s', 60: '/min', 3600: '/h' })[$('unit').value];
  const unitMul = () => Number($('unit').value);
  function num(v) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2).replace(/\.?0+$/, '');
    return v.toPrecision(2);
  }
  const rate = (v) => num(v * unitMul());
  function power(w) {
    if (w >= 1e9) return num(w / 1e9) + ' GW';
    if (w >= 1e6) return num(w / 1e6) + ' MW';
    return num(w / 1e3) + ' kW';
  }
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  };

  // Items that some recipe or resource produces.
  const craftable = new Set();
  for (const r of Object.values(data.recipes)) for (const p of r.results || []) craftable.add(p.name);
  for (const r of Object.values(data.resources || {})) for (const p of (r.results || [])) craftable.add(p.name);
  const names = [...craftable].filter((n) => data.items[n] || data.fluids[n]).sort();
  $('items').innerHTML = names.map((n) => `<option value="${n}">${pretty(n)}</option>`).join('');

  let plan = null, gp = null, lay = null, selected = null, vb = { x: 0, y: 0, w: 1000, h: 600 };
  const svg = $('svg');

  // User settings. Empty means automatic. Passed to the solver in solverSettings().
  const cfg = {
    machineByCategory: {}, machines: {}, drill: '', limitResearch: false, researched: new Set(),
    mods: {}, nodeMods: {}, enabled: new Set(), disabled: new Set(),
    oil: { mode: 'auto', cracking: true },
    view: 'machines', source: '',
    groups: { rule: 'chain', manual: false, state: null },
  };
  const CRACKING = ['heavy-oil-cracking', 'light-oil-cracking'];
  // Oil recipes shown in the oil panel. Fluid names the panel balances.
  const OIL_RECIPES = ['basic-oil-processing', 'advanced-oil-processing', 'heavy-oil-cracking', 'light-oil-cracking',
    'coal-liquefaction', 'simple-coal-liquefaction'];
  const OIL_FLUIDS = ['crude-oil', 'heavy-oil', 'light-oil', 'petroleum-gas'];
  const solverSettings = () => {
    // Oil mode and cracking switch recipes off, on top of the alternate picker.
    const off = new Set(cfg.disabled);
    if (cfg.oil.mode === 'basic') off.add('advanced-oil-processing');
    if (cfg.oil.mode === 'advanced') off.add('basic-oil-processing');
    if (!cfg.oil.cracking) CRACKING.forEach((r) => off.add(r));
    const s = {
      machineByCategory: cfg.machineByCategory, machines: cfg.machines,
      mods: cfg.mods, nodeMods: cfg.nodeMods,
      enabledRecipes: [...cfg.enabled], disabledRecipes: [...off],
    };
    // Sources: one planet only, or any planet with Nauvis preferred (settings.home).
    if (cfg.source) s.planet = cfg.source; else s.home = 'nauvis';
    if (cfg.drill) s.drill = cfg.drill;
    if (cfg.limitResearch) s.researched = [...cfg.researched];
    return s;
  };

  function run() {
    saveSoon();
    const item = $('item').value.trim();
    const r = Number($('rate').value) / unitMul();
    if (!names.includes(item) || !(r > 0)) { svg.innerHTML = ''; $('pane-plan').innerHTML = '<p class="note">Pick an item and a rate.</p>'; return; }
    const t0 = performance.now();
    const keep = selected;
    plan = FPSolver.solve(data, { item, rate: r, settings: solverSettings() });
    if (!plan.ok) { svg.innerHTML = ''; $('pane-plan').innerHTML = `<p class="warn">No solution (${plan.status || 'unknown'}).</p>`; return; }
    // Groups: automatic proposals follow the plan. After a manual edit the user's assignments stay.
    const gs = cfg.groups.manual ? FPGroups.reconcile(plan, cfg.groups.state) : FPGroups.propose(plan, cfg.groups.rule, data);
    gp = FPGroups.groupPlan(plan, gs, data, { prefer: cfg.source || 'nauvis' });
    cfg.groups.state = gp.state;
    lay = FPLayout.layout(cfg.view === 'groups' ? gp.plan : plan);
    plan.ms = performance.now() - t0;
    selected = keep && lay.nodes.some((n) => n.id === keep) ? keep : null;
    draw(!keep);
    summary();
    groupsPanel();
  }

  // Groups tab: propose, rename, move machines, merge, delete.
  const openGroups = new Set();
  function editGroups(fn) {
    const s = cfg.groups.state;
    const st = { assign: Object.assign({}, s.assign), names: Object.assign({}, s.names), order: s.order.slice(), planet: Object.assign({}, s.planet) };
    fn(st);
    cfg.groups.manual = true;
    cfg.groups.state = st;
    run();
  }
  function groupsPanel() {
    const pane = $('pane-grp');
    if (!plan || !gp) { pane.innerHTML = ''; return; }
    const st = gp.state;
    const movable = plan.nodes.filter((n) => n.kind !== 'external');
    const nodeLabel = (n) => (n.kind === 'mine' ? 'Mine ' : n.kind === 'pump' ? 'Pump ' : '') + pretty(n.name);
    const moveOpts = (cur) => `<option value="">Move to...</option>${st.order.filter((g) => g !== cur).map((g) => `<option value="${g}">${esc(st.names[g])}</option>`).join('')}<option value="__new">New group</option>${cur ? '<option value="__none">Ungrouped</option>' : ''}`;
    const planetOpts = (info) => `<option value="">Auto${info.planetSet ? '' : ' (' + pretty(info.planet) + ')'}</option>` +
      gp.planetList.map((p) => `<option value="${p}"${info.planetSet && info.planet === p ? ' selected' : ''}>${pretty(p)}${info.fit.includes(p) ? '' : ' (not valid)'}</option>`).join('');
    const groupRows = st.order.map((g) => {
      const members = movable.filter((n) => st.assign[n.id] === g);
      const info = gp.groups.find((x) => x.gid === g);
      return `<details data-g="${g}"${openGroups.has(g) ? ' open' : ''}><summary>${esc(st.names[g])} (${members.length}) - ${pretty(info.planet)}${info.problems.length ? ' <span class="warn">!</span>' : ''}</summary>
        <input class="gname" data-gname="${g}" value="${esc(st.names[g])}">
        <div class="row"><span>Planet</span><select data-planet="${g}">${planetOpts(info)}</select></div>
        ${info.problems.map((x) => `<p class="note warn">${x}</p>`).join('')}
        ${members.map((n) => `<div class="row"><span>${nodeLabel(n)}</span><select data-move="${n.id}" data-from="${g}">${moveOpts(g)}</select></div>`).join('')}
        <div class="row"><select data-merge="${g}"><option value="">Merge into...</option>${st.order.filter((x) => x !== g).map((x) => `<option value="${x}">${esc(st.names[x])}</option>`).join('')}</select>
        <button class="sm" data-del="${g}">Ungroup all</button></div></details>`;
    }).join('');
    const loose = movable.filter((n) => !st.assign[n.id]);
    pane.innerHTML = `
      <h2>Proposal</h2>
      <div class="row"><select id="grule"><option value="chain"${cfg.groups.rule === 'chain' ? ' selected' : ''}>By product chain</option><option value="category"${cfg.groups.rule === 'category' ? ' selected' : ''}>By machine type</option></select>
      <button class="sm" id="gprop">Propose</button></div>
      <p class="note">${cfg.groups.manual ? 'You edited the groups. New machines stay ungrouped until you press Propose.' : 'Groups follow the plan automatically until you edit them.'}</p>
      <p class="note">Product chain: a machine joins the group of its only consumer. A machine with two or more consumers starts its own group. Machine type: one group per kind of work.</p>
      <h2>Groups</h2>${groupRows || '<p class="note">none</p>'}
      ${loose.length ? `<h2>Ungrouped</h2>${loose.map((n) => `<div class="row"><span>${nodeLabel(n)}</span><select data-move="${n.id}" data-from="">${moveOpts('')}</select></div>`).join('')}` : ''}`;
    $('grule').addEventListener('change', (ev) => { cfg.groups.rule = ev.target.value; if (!cfg.groups.manual) run(); });
    $('gprop').addEventListener('click', () => { cfg.groups.manual = false; run(); });
    for (const d of pane.querySelectorAll('details')) d.addEventListener('toggle', () => { if (d.open) openGroups.add(d.dataset.g); else openGroups.delete(d.dataset.g); });
    for (const i of pane.querySelectorAll('[data-gname]')) i.addEventListener('change', () => editGroups((s) => { s.names[i.dataset.gname] = i.value.trim() || s.names[i.dataset.gname]; }));
    for (const m of pane.querySelectorAll('[data-planet]')) m.addEventListener('change', () => editGroups((s) => {
      if (m.value) s.planet[m.dataset.planet] = m.value; else delete s.planet[m.dataset.planet];
    }));
    for (const b of pane.querySelectorAll('[data-del]')) b.addEventListener('click', () => editGroups((s) => {
      for (const k of Object.keys(s.assign)) if (s.assign[k] === b.dataset.del) delete s.assign[k];
    }));
    for (const m of pane.querySelectorAll('[data-merge]')) m.addEventListener('change', () => { if (!m.value) return; editGroups((s) => {
      for (const k of Object.keys(s.assign)) if (s.assign[k] === m.dataset.merge) s.assign[k] = m.value;
    }); });
    for (const m of pane.querySelectorAll('[data-move]')) m.addEventListener('change', () => { if (!m.value) return; editGroups((s) => {
      const id = m.dataset.move;
      if (m.value === '__none') delete s.assign[id];
      else if (m.value === '__new') {
        const g = 'u' + Date.now().toString(36);
        s.names[g] = 'New group'; s.order.push(g); s.assign[id] = g;
        openGroups.add(g);
      } else s.assign[id] = m.value;
    }); });
  }

  function draw(fit) {
    svg.innerHTML = '';
    const g = el('g');
    svg.appendChild(g);
    const showLabels = $('labels').checked;
    const eg = el('g'), ng = el('g'), lg = el('g');
    g.append(eg, ng, lg);
    const maxRate = Math.max(...lay.edges.map((e) => e.link.rate), 1e-9);
    const hl = new Set();
    if (selected) for (const e of lay.edges) if (e.link.from === selected || e.link.to === selected) hl.add(e);
    lay.edges.forEach((e) => {
      const w = 1.2 + 5 * Math.sqrt(e.link.rate / maxRate);
      const p = el('path', { d: e.d, class: 'edge' + (e.back ? ' back' : '') + (e.link.cross ? ' cross' : '') + (hl.has(e) ? ' hl' : ''), 'stroke-width': w });
      p.appendChild(el('title', {}, `${pretty(e.link.item)}: ${rate(e.link.rate)}${unitName()}` +
        (e.link.cross ? ` (import ${pretty(e.link.fromPlanet)} to ${pretty(e.link.toPlanet)})` : '')));
      eg.appendChild(p);
      if (showLabels || hl.has(e)) {
        const mx = (e.sx + e.tx) / 2, my = (e.sy + e.ty) / 2;
        lg.appendChild(el('text', { x: mx, y: my - 3, 'text-anchor': 'middle', class: 'elabel' }, `${pretty(e.link.item)} ${rate(e.link.rate)}${e.link.cross ? ' [import]' : ''}`));
      }
    });
    for (const n of lay.nodes) {
      const grp = el('g', { class: 'node' + (n.id === selected ? ' sel' : ''), transform: `translate(${n.x},${n.y})` });
      // Groups share one color per group, so a machine box shows which group it belongs to.
      const gId = n.ref.kind === 'group' ? n.ref.gid : gp && gp.state.assign[n.id];
      const rectAttrs = { class: 'box ' + n.ref.kind, width: n.w, height: n.h, rx: 6 };
      if (gId) rectAttrs.style = `fill:hsl(${(gp.state.order.indexOf(gId) * 67 + 20) % 360} 45% 55% / .28)`;
      grp.appendChild(el('rect', rectAttrs));
      if (n.ref.kind === 'group' && n.ref.planet) {
        grp.appendChild(el('rect', { x: 0, y: 0, width: 6, height: n.h, rx: 3, style: `fill:hsl(${planetHue(n.ref.planet)} 60% 50%)` }));
      }
      const [t1, t2, t3] = nodeText(n.ref);
      grp.appendChild(el('text', { x: 10, y: 20, class: 't1' }, t1));
      if (t2) grp.appendChild(el('text', { x: 10, y: 37, class: 't2' }, t2));
      if (t3) grp.appendChild(el('text', { x: 10, y: 53, class: 't2' }, t3));
      grp.addEventListener('click', (ev) => { ev.stopPropagation(); selected = selected === n.id ? null : n.id; draw(false); summary(); });
      ng.appendChild(grp);
    }
    if (fit) { vb = { x: 0, y: 0, w: lay.width, h: lay.height }; fitAspect(); }
    setVB();
  }

  function nodeText(n) {
    switch (n.kind) {
      case 'recipe': return [`${num(n.machines)}x ${pretty(n.machine)}`, pretty(n.name), n.powerW ? power(n.powerW) : (n.fuelW ? 'fuel ' + power(n.fuelW) : '')];
      case 'mine': return [`${num(n.machines)}x ${pretty(n.machine)}`, 'Mine ' + pretty(n.name), n.powerW ? power(n.powerW) : ''];
      case 'pump': return [`${num(n.machines)}x ${pretty(n.machine)}`, 'Pump ' + pretty(n.name), ''];
      case 'external': return ['External input', pretty(n.name), ''];
      case 'group': return [n.name, `${pretty(n.planet || 'nauvis')}${n.problems && n.problems.length ? ' (!)' : ''}, ${n.machines} machines`, n.powerW ? power(n.powerW) : (n.fuelW ? 'fuel ' + power(n.fuelW) : '')];
      case 'target': return ['Target', pretty(n.name), ''];
      default: return ['Surplus', 'Not consumed', ''];
    }
  }

  function summary() {
    const u = unitName();
    const rows = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<tr><td>${pretty(k)}</td><td>${rate(v)}${u}</td></tr>`).join('') || '<tr><td class="note">none</td><td></td></tr>';
    let h = `<h2>Plan</h2><table>
      <tr><td>Target</td><td>${pretty(plan.target)} ${rate(plan.rate)}${u}</td></tr>
      <tr><td>Electric power</td><td>${power(plan.powerW)}</td></tr>
      ${plan.fuelW ? `<tr><td>Burner fuel</td><td>${power(plan.fuelW)}</td></tr>` : ''}
      <tr><td>Solve time</td><td>${plan.ms.toFixed(0)} ms</td></tr></table>`;
    h += `<h2>Raw inputs</h2><table>${rows(plan.raw)}</table>`;
    if (gp && Object.keys(gp.planets).length > 1) {
      h += `<h2>By planet</h2><table>${Object.entries(gp.planets).map(([p, v]) =>
        `<tr><td>${pretty(p)} (${v.groups} groups)</td><td>${v.machines} machines, ${power(v.powerW)}</td></tr>`).join('')}</table>`;
      if (gp.transfers.length) h += `<h2>Imports between planets</h2><table>${gp.transfers.sort((a, b) => b.rate - a.rate).map((t) =>
        `<tr><td>${pretty(t.item)}: ${pretty(t.from)} to ${pretty(t.to)}</td><td>${rate(t.rate)}${u}</td></tr>`).join('')}</table>`;
    }
    if (gp && gp.groups.some((g) => g.problems.length)) h += `<p class="note warn">Some groups have machines that cannot run on their planet. See the Groups tab.</p>`;
    h += oilHtml();
    if (Object.keys(plan.external).length) h += `<h2 class="warn">External inputs (no modeled source)</h2><table>${rows(plan.external)}</table>`;
    if (Object.keys(plan.surplus).length) h += `<h2>Surplus byproducts</h2><table>${rows(plan.surplus)}</table>`;
    h += `<h2>Machines (rounded up)</h2><table>${Object.entries(plan.machineTotals).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<tr><td>${pretty(k)}</td><td>${v}</td></tr>`).join('')}</table>`;
    if (selected) {
      const n = lay.nodes.find((x) => x.id === selected);
      const ins = lay.edges.filter((e) => e.link.to === selected), outs = lay.edges.filter((e) => e.link.from === selected);
      const label = (id) => { const o = lay.nodes.find((x) => x.id === id); return o.ref.kind === 'target' || o.ref.kind === 'surplus' ? pretty(o.ref.kind) : o.ref.kind === 'group' ? esc(o.ref.name) : (o.ref.kind === 'recipe' ? '' : pretty(o.ref.kind) + ' ') + pretty(o.ref.name); };
      const lr = (es, who) => es.map((e) => `<tr><td>${pretty(e.link.item)} ${who} ${label(who === 'from' ? e.link.from : e.link.to)}</td><td>${rate(e.link.rate)}${u}</td></tr>`).join('');
      if (n.ref.kind === 'group') {
        const memberRows = n.ref.members.map((id) => plan.nodes.find((x) => x.id === id)).map((m) =>
          `<tr><td>${pretty(m.name)}</td><td>${num(m.machines)}x ${pretty(m.machine || '')}</td></tr>`).join('');
        h = `<h2>Group: ${esc(n.ref.name)}</h2><table>
          <tr><td>Machines (rounded up)</td><td>${n.ref.machines}</td></tr>
          <tr><td>Planet</td><td>${pretty(n.ref.planet)}${n.ref.planetSet ? '' : ' (suggested)'}</td></tr>
          <tr><td>Electric power</td><td>${power(n.ref.powerW)}</td></tr></table>
          ${n.ref.problems.map((x) => `<p class="note warn">${x}</p>`).join('')}
          ${n.ref.imports.length ? `<h2>Imports from other planets</h2><table>${n.ref.imports.map((x) => `<tr><td>${pretty(x.item)} from ${pretty(x.fromPlanet)}</td><td>${rate(x.rate)}${u}</td></tr>`).join('')}</table>` : ''}
          <h2>Inputs</h2><table>${lr(ins, 'from') || '<tr><td class="note">none</td><td></td></tr>'}</table>
          <h2>Outputs</h2><table>${lr(outs, 'to') || '<tr><td class="note">none</td><td></td></tr>'}</table>
          ${Object.keys(n.ref.raw).length ? `<h2>Raw resources mined here</h2><table>${rows(n.ref.raw)}</table>` : ''}
          <h2>Members</h2><table>${memberRows}</table>` + h;
      } else {
        h = `<h2>Selected: ${nodeText(n.ref)[1] || nodeText(n.ref)[0]}</h2><table>
        ${n.ref.machines != null ? `<tr><td>Machines (exact)</td><td>${n.ref.machines.toFixed(3)}</td></tr>` : ''}
        ${n.ref.productivity ? `<tr><td>Productivity</td><td>+${(n.ref.productivity * 100).toFixed(0)}%</td></tr>` : ''}
        ${lr(ins, 'from')}${lr(outs, 'to')}</table>` + overrideHtml(n.ref) + nodeModsHtml(n.ref) + h;
      }
    }
    if (plan.notes.length) h += `<h2>Notes</h2>` + plan.notes.map((x) => `<p class="note">${x}</p>`).join('');
    $('pane-plan').innerHTML = h;
    const nm = $('nodemod');
    if (nm) {
      const key = nm.dataset.key;
      nm.addEventListener('change', () => {
        if (nm.checked) cfg.nodeMods[key] = Object.assign({}, cfg.mods); else delete cfg.nodeMods[key];
        run();
      });
      if (cfg.nodeMods[key]) wireSpec($('nodespec'), cfg.nodeMods[key], run);
    }
    const ov = $('ovr');
    if (ov) ov.addEventListener('change', () => {
      const key = ov.dataset.key;
      if (ov.value) cfg.machines[key] = ov.value; else delete cfg.machines[key];
      run();
    });
  }

  // Oil panel: refinery and cracking recipes in the plan, plus the balance of each oil fluid.
  // Made and used are summed over every node in the plan, so solid fuel, plastic, sulfur and
  // other consumers all count as use. Surplus is what the solver could not place.
  function oilHtml() {
    const oilNodes = plan.nodes.filter((n) => n.kind === 'recipe' && OIL_RECIPES.includes(n.name));
    if (!oilNodes.length) return '';
    const u = unitName();
    const made = {}, used = {};
    for (const n of plan.nodes) {
      for (const [i, v] of Object.entries(n.outputs)) if (OIL_FLUIDS.includes(i)) made[i] = (made[i] || 0) + v;
      for (const [i, v] of Object.entries(n.inputs)) if (OIL_FLUIDS.includes(i)) used[i] = (used[i] || 0) + v;
    }
    const recipeRows = oilNodes.map((n) =>
      `<tr><td>${pretty(n.name)}</td><td>${num(n.machines)}x ${pretty(n.machine)}</td></tr>`).join('');
    const fluidRows = OIL_FLUIDS.filter((f) => made[f] || used[f]).map((f) => {
      const s = plan.surplus[f] || 0;
      return `<tr><td>${pretty(f)}</td><td>${rate(made[f] || 0)} made, ${rate(used[f] || 0)} used${s > 1e-6 ? `, <span class="warn">${rate(s)} surplus</span>` : ''}</td></tr>`;
    }).join('');
    const surplusOil = OIL_FLUIDS.some((f) => plan.surplus[f] > 1e-6);
    return `<h2>Oil balance (${u})</h2><table>${recipeRows}</table><table style="margin-top:6px">${fluidRows}</table>` +
      (surplusOil ? '<p class="note warn">In the game, a surplus oil fluid backs up and stalls the refinery. Add a consumer, a solid fuel recipe, or storage for it.</p>' : '');
  }

  // Machines that can run a recipe or mine a resource, for the per-node override.
  function machineChoices(n) {
    if (n.kind === 'recipe') {
      const props = null;
      return { key: n.name, list: FPSolver.candidateMachines(data, data.recipes[n.name], props) };
    }
    if (n.kind === 'mine') {
      const cat = (data.resources[n.name] || {}).category || FPSolver.DEFAULTS.resourceCategory;
      return { key: 'mine:' + n.name, list: Object.keys(data.mining_drills).filter((d) => data.mining_drills[d].resource_categories.includes(cat)) };
    }
    return null;
  }
  function overrideHtml(n) {
    const c = machineChoices(n);
    if (!c || c.list.length < 2) return '';
    const cur = cfg.machines[c.key] || '';
    const opts = ['<option value="">Automatic</option>'].concat(c.list.map((m) => `<option value="${m}"${m === cur ? ' selected' : ''}>${pretty(m)}</option>`));
    return `<div class="row"><span>Machine for this node</span><select id="ovr" data-key="${c.key}">${opts.join('')}</select></div>`;
  }

  // Per-node module settings: replace the global spec for this recipe or mine.
  function nodeModsHtml(n) {
    const c = machineChoices(n);
    if (!c) return '';
    const spec = cfg.nodeMods[c.key];
    return `<div class="row"><label><input type="checkbox" id="nodemod" data-key="${c.key}"${spec ? ' checked' : ''}> Own modules for this node</label></div>` +
      (spec ? `<div id="nodespec">${specHtml(spec)}</div>` : '');
  }

  // Settings tab: default machine per category, default drill, research checklist.
  const SKIP_CATS = ['recycling', 'crushing', 'captive-spawner-process', 'parameters', 'hand-crafting'];
  function settingsPanel() {
    const cats = new Set();
    for (const r of Object.values(data.recipes)) for (const c of (r.categories && r.categories.length ? r.categories : ['crafting'])) cats.add(c);
    const rows = [...cats].filter((c) => !SKIP_CATS.includes(c)).sort().map((c) => {
      const ms = Object.entries(data.machines).filter(([, m]) => !m.fixed_recipe && m.crafting_categories && m.crafting_categories.includes(c)).map(([n]) => n);
      if (ms.length < 2) return '';
      const cur = cfg.machineByCategory[c] || '';
      return `<div class="row"><span>${pretty(c)}</span><select data-cat="${c}"><option value="">Automatic</option>${ms.map((m) => `<option value="${m}"${m === cur ? ' selected' : ''}>${pretty(m)}</option>`).join('')}</select></div>`;
    }).join('');
    const drills = Object.keys(data.mining_drills).filter((d) => data.mining_drills[d].resource_categories.includes('basic-solid'));
    $('pane-set').innerHTML = `
      <h2>Default machines</h2>
      <p class="note">Automatic picks the fastest machine. With the research limit on, it picks the fastest unlocked one. A choice on a single node overrides these.</p>
      ${rows}
      <div class="row"><span>Mining drill (solids)</span><select id="drill"><option value="">Automatic</option>${drills.map((d) => `<option value="${d}"${d === cfg.drill ? ' selected' : ''}>${pretty(d)}</option>`).join('')}</select></div>
      <h2>Research</h2>
      <label><input type="checkbox" id="limit"${cfg.limitResearch ? ' checked' : ''}> Limit to researched technology</label>
      <p class="note">Off: every recipe and machine is available. On: only starting recipes and recipes unlocked by the technologies you tick. Ticking a technology also ticks its prerequisites.</p>
      <div id="techbox"></div>
      <h2>Oil</h2>
      <div class="row"><span>Refining</span><select id="oilmode"><option value="auto">Automatic (solver picks)</option><option value="basic">Basic only</option><option value="advanced">Advanced only</option></select></div>
      <div class="row"><label><input type="checkbox" id="cracking" checked> Cracking allowed</label></div>
      <p class="note">Coal liquefaction is in the alternate recipe list below.</p>
      <h2>Modules, beacons, quality</h2>
      <p class="note">Applies to every machine that can take it. One module type per machine and per beacon. Quality modules are not modeled beyond their speed penalty. Quality bonus per level (+30%) is from the wiki, not the game dump.</p>
      <div id="modbox"></div>
      <h2>Alternate recipes</h2>
      <p class="note">Items with more than one recipe. Ticked recipes may be used. Some are off by default because they are rarely the first choice.</p>
      <input id="afilter" placeholder="Filter items" style="width:100%">
      <div id="altbox"></div>`;
    for (const s of $('pane-set').querySelectorAll('select[data-cat]')) s.addEventListener('change', () => {
      if (s.value) cfg.machineByCategory[s.dataset.cat] = s.value; else delete cfg.machineByCategory[s.dataset.cat];
      run();
    });
    $('drill').addEventListener('change', (ev) => { cfg.drill = ev.target.value; run(); });
    $('limit').addEventListener('change', (ev) => { cfg.limitResearch = ev.target.checked; techBox(); run(); });
    techBox();
    $('oilmode').addEventListener('change', (ev) => { cfg.oil.mode = ev.target.value; run(); });
    $('cracking').addEventListener('change', (ev) => { cfg.oil.cracking = ev.target.checked; run(); });
    $('modbox').innerHTML = specHtml(cfg.mods);
    wireSpec($('modbox'), cfg.mods, run);
    altBox();
    $('afilter').addEventListener('input', altBox);
  }

  // Module spec form. spec fields match the solver: module, count, quality, machineQuality,
  // beacons, bModule, bQuality, beaconQuality.
  const QUALITIES = Object.keys(data.quality).filter((q) => q !== 'quality-unknown').sort((a, b) => data.quality[a].level - data.quality[b].level);
  const MODULES = Object.keys(data.modules).sort();
  function specHtml(spec) {
    const sel = (f, list, none) => `<select data-f="${f}">${none ? `<option value="">${none}</option>` : ''}${list.map((v) =>
      `<option value="${v}"${(spec[f] || (none ? '' : 'normal')) === v ? ' selected' : ''}>${pretty(v)}</option>`).join('')}</select>`;
    const numIn = (f, ph) => `<input type="number" min="0" step="1" data-f="${f}" placeholder="${ph}" value="${spec[f] == null ? '' : spec[f]}">`;
    return `
      <div class="row"><span>Machine quality</span>${sel('machineQuality', QUALITIES)}</div>
      <div class="row"><span>Module</span>${sel('module', MODULES, 'None')}</div>
      <div class="row"><span>Module quality</span>${sel('quality', QUALITIES)}</div>
      <div class="row"><span>Modules per machine</span>${numIn('count', 'fill')}</div>
      <div class="row"><span>Beacons per machine</span>${numIn('beacons', '0')}</div>
      <div class="row"><span>Beacon module</span>${sel('bModule', MODULES.filter((m) => !/^(productivity|quality)/.test(m)), 'None')}</div>
      <div class="row"><span>Beacon module quality</span>${sel('bQuality', QUALITIES)}</div>
      <div class="row"><span>Beacon quality</span>${sel('beaconQuality', QUALITIES)}</div>`;
  }
  function wireSpec(root, spec, onChange) {
    for (const e of root.querySelectorAll('[data-f]')) e.addEventListener('change', () => {
      const f = e.dataset.f;
      if (e.type === 'number') spec[f] = e.value === '' ? null : Math.max(0, Math.floor(Number(e.value)));
      else spec[f] = e.value;
      onChange();
    });
  }

  // Alternate recipe picker: every item with two or more recipes.
  function altBox() {
    const q = ($('afilter').value || '').toLowerCase().replace(/ /g, '-');
    const byItem = {};
    for (const [name, r] of Object.entries(data.recipes)) {
      const cats = r.categories && r.categories.length ? r.categories : ['crafting'];
      if (r.parameter || cats.includes('parameters') || cats.includes('recycling') || name.endsWith('-barrel')) continue;
      for (const p of r.results || []) (byItem[p.name] = byItem[p.name] || new Set()).add(name);
    }
    const on = (n) => cfg.enabled.has(n) || (FPSolver.defaultOn(n, data.recipes[n]) && !cfg.disabled.has(n));
    const items = Object.keys(byItem).filter((i) => byItem[i].size > 1 && i.includes(q)).sort();
    $('altbox').innerHTML = items.map((i) => `<details><summary>${pretty(i)} (${byItem[i].size})</summary>${[...byItem[i]].sort().map((n) =>
      `<label><input type="checkbox" data-r="${n}"${on(n) ? ' checked' : ''}> ${pretty(n)}${FPSolver.defaultOn(n, data.recipes[n]) ? '' : ' <span class="note">(off by default)</span>'}</label>`).join('<br>')}</details>`).join('');
    for (const c of $('altbox').querySelectorAll('input[data-r]')) c.addEventListener('change', () => {
      const n = c.dataset.r, def = FPSolver.defaultOn(n, data.recipes[n]);
      if (c.checked) { if (def) cfg.disabled.delete(n); else cfg.enabled.add(n); }
      else if (def) cfg.disabled.add(n); else cfg.enabled.delete(n);
      run();
    });
  }

  function techBox() {
    const box = $('techbox');
    if (!cfg.limitResearch) { box.innerHTML = ''; return; }
    const techs = Object.keys(data.technologies).sort();
    box.innerHTML = `<div class="row"><input id="tfilter" placeholder="Filter technologies" style="flex:1"><button id="tall">All</button><button id="tnone">None</button></div><div id="techs"></div>`;
    const list = $('techs');
    const paint = () => {
      const q = $('tfilter').value.toLowerCase();
      list.innerHTML = techs.filter((t) => t.includes(q.replace(/ /g, '-'))).map((t) =>
        `<label><input type="checkbox" data-t="${t}"${cfg.researched.has(t) ? ' checked' : ''}> ${pretty(t)}</label>`).join('');
    };
    const prereqs = (t, acc) => { for (const p of data.technologies[t].prerequisites || []) if (!acc.has(p) && data.technologies[p]) { acc.add(p); prereqs(p, acc); } return acc; };
    list.addEventListener('change', (ev) => {
      const t = ev.target.dataset.t;
      if (ev.target.checked) { cfg.researched.add(t); prereqs(t, new Set()).forEach((p) => cfg.researched.add(p)); }
      else {
        cfg.researched.delete(t);
        // Unticking removes every technology that depends on it.
        for (const o of [...cfg.researched]) if (prereqs(o, new Set()).has(t)) cfg.researched.delete(o);
      }
      paint(); run();
    });
    $('tfilter').addEventListener('input', paint);
    $('tall').addEventListener('click', () => { techs.forEach((t) => cfg.researched.add(t)); paint(); run(); });
    $('tnone').addEventListener('click', () => { cfg.researched.clear(); paint(); run(); });
    paint();
  }

  $('tabs').addEventListener('click', (ev) => {
    const t = ev.target.dataset.tab;
    if (!t) return;
    for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === t);
    $('pane-plan').hidden = t !== 'plan';
    $('pane-set').hidden = t !== 'set';
    $('pane-grp').hidden = t !== 'grp';
  });

  // Pan and zoom by changing the viewBox.
  function fitAspect() {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const k = Math.max(vb.w / r.width, vb.h / r.height);
    vb.x -= (r.width * k - vb.w) / 2; vb.y -= (r.height * k - vb.h) / 2;
    vb.w = r.width * k; vb.h = r.height * k;
  }
  const setVB = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    const f = ev.deltaY > 0 ? 1.15 : 1 / 1.15;
    const px = vb.x + (ev.clientX - r.left) / r.width * vb.w, py = vb.y + (ev.clientY - r.top) / r.height * vb.h;
    vb = { x: px - (px - vb.x) * f, y: py - (py - vb.y) * f, w: vb.w * f, h: vb.h * f };
    setVB();
  }, { passive: false });
  let drag = null;
  // Capture the pointer only once the mouse moves, so a plain click still reaches the box under it.
  svg.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, vb: { ...vb }, moved: false, id: ev.pointerId }; });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 4) return;
      drag.moved = true; svg.classList.add('drag'); svg.setPointerCapture(drag.id);
    }
    const r = svg.getBoundingClientRect();
    vb.x = drag.vb.x - (ev.clientX - drag.x) / r.width * vb.w;
    vb.y = drag.vb.y - (ev.clientY - drag.y) / r.height * vb.h;
    setVB();
  });
  svg.addEventListener('pointerup', () => { drag = null; svg.classList.remove('drag'); });
  svg.addEventListener('click', () => { if (selected) { selected = null; draw(false); summary(); } });
  window.addEventListener('resize', () => { if (lay) { vb = { x: 0, y: 0, w: lay.width, h: lay.height }; fitAspect(); setVB(); } });

  // ---- State: URL hash, JSON export and import (step 8) ----
  // One state object holds every user choice. It is saved in the URL hash as "#s=" + a code:
  // "z" + base64url of deflate-raw JSON, or "j" + base64url of plain JSON when the browser has no
  // CompressionStream. Anything read from a URL or a file is untrusted, so cleanState() keeps only
  // known keys with known value types and drops names that are not in the game data.
  const STATE_VERSION = 1;
  const UNITS = ['1', '60', '3600'];
  const SPEC_KEYS = ['module', 'count', 'quality', 'machineQuality', 'beacons', 'bModule', 'bCount', 'bQuality', 'beaconQuality'];
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const strs = (x, ok) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string' && ok(v)) : []);
  const idOk = (v) => /^[\w-]{1,32}$/.test(v);

  function getState() {
    const c = {
      machineByCategory: cfg.machineByCategory, machines: cfg.machines, drill: cfg.drill,
      limitResearch: cfg.limitResearch, mods: cfg.mods, nodeMods: cfg.nodeMods,
      enabled: [...cfg.enabled], disabled: [...cfg.disabled], oil: cfg.oil,
      view: cfg.view, source: cfg.source, groupRule: cfg.groups.rule,
    };
    if (cfg.limitResearch) c.researched = [...cfg.researched];
    if (cfg.groups.manual && cfg.groups.state) c.groups = cfg.groups.state;
    return { v: STATE_VERSION, item: $('item').value.trim(), rate: Number($('rate').value), unit: $('unit').value, labels: $('labels').checked, cfg: c };
  }

  function cleanSpec(x) {
    const out = {};
    if (!isObj(x)) return out;
    for (const k of SPEC_KEYS) {
      const v = x[k];
      if (['module', 'bModule'].includes(k)) { if (MODULES.includes(v)) out[k] = v; }
      else if (['quality', 'machineQuality', 'bQuality', 'beaconQuality'].includes(k)) { if (QUALITIES.includes(v)) out[k] = v; }
      else if (v === null) out[k] = null;
      else if (Number.isFinite(v) && v >= 0) out[k] = Math.min(Math.floor(v), 100);
    }
    return out;
  }

  function cleanState(raw) {
    if (!isObj(raw) || !isObj(raw.cfg)) throw new Error('not a planner state');
    const c = raw.cfg, o = {};
    o.item = typeof raw.item === 'string' && names.includes(raw.item) ? raw.item : '';
    o.rate = Number.isFinite(raw.rate) && raw.rate > 0 ? raw.rate : 1;
    o.unit = UNITS.includes(String(raw.unit)) ? String(raw.unit) : '1';
    o.labels = raw.labels !== false;
    const machOk = (v) => typeof v === 'string' && (data.machines[v] || data.mining_drills[v]);
    const mapOf = (x) => Object.fromEntries(Object.entries(isObj(x) ? x : {}).filter(([k, v]) => k.length < 100 && machOk(v)));
    o.machineByCategory = mapOf(c.machineByCategory);
    o.machines = mapOf(c.machines);
    o.drill = typeof c.drill === 'string' && data.mining_drills[c.drill] ? c.drill : '';
    o.limitResearch = c.limitResearch === true;
    o.researched = strs(c.researched, (v) => data.technologies[v]);
    o.mods = cleanSpec(c.mods);
    o.nodeMods = Object.fromEntries(Object.entries(isObj(c.nodeMods) ? c.nodeMods : {}).filter(([k]) => k.length < 100).map(([k, v]) => [k, cleanSpec(v)]));
    o.enabled = strs(c.enabled, (v) => data.recipes[v]);
    o.disabled = strs(c.disabled, (v) => data.recipes[v]);
    const oil = isObj(c.oil) ? c.oil : {};
    o.oil = { mode: ['auto', 'basic', 'advanced'].includes(oil.mode) ? oil.mode : 'auto', cracking: oil.cracking !== false };
    o.view = c.view === 'groups' ? 'groups' : 'machines';
    const planets = FPGroups.planetNames(data);
    o.source = typeof c.source === 'string' && planets.includes(c.source) ? c.source : '';
    o.groupRule = c.groupRule === 'category' ? 'category' : 'chain';
    o.groups = null;
    if (isObj(c.groups) && isObj(c.groups.assign) && isObj(c.groups.names) && Array.isArray(c.groups.order)) {
      const g = c.groups, order = strs(g.order, idOk).slice(0, 200);
      const nm = {}, assign = {}, planet = {};
      for (const id of order) nm[id] = typeof g.names[id] === 'string' ? g.names[id].slice(0, 60) : id;
      for (const [k, v] of Object.entries(g.assign)) if (k.length < 100 && order.includes(v)) assign[k] = v;
      for (const [k, v] of Object.entries(isObj(g.planet) ? g.planet : {})) if (order.includes(k) && planets.includes(v)) planet[k] = v;
      o.groups = { assign, names: nm, order, planet };
    }
    return o;
  }

  function applyState(o) {
    if (o.item) $('item').value = o.item;
    $('rate').value = o.rate; $('unit').value = o.unit; $('labels').checked = o.labels;
    Object.assign(cfg, {
      machineByCategory: o.machineByCategory, machines: o.machines, drill: o.drill, limitResearch: o.limitResearch,
      researched: new Set(o.researched), mods: o.mods, nodeMods: o.nodeMods, enabled: new Set(o.enabled),
      disabled: new Set(o.disabled), oil: o.oil, view: o.view, source: o.source,
    });
    cfg.groups = { rule: o.groupRule, manual: !!o.groups, state: o.groups };
    $('viewmode').value = o.view; $('src').value = o.source;
    selected = null; openGroups.clear();
    settingsPanel();
    run();
  }

  const toB64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64 = (t) => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  async function encodeState(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream === 'undefined') return 'j' + toB64(bytes);
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
    return 'z' + toB64(new Uint8Array(out));
  }
  async function decodeState(code) {
    const bytes = fromB64(code.slice(1));
    if (code[0] === 'j') return JSON.parse(new TextDecoder().decode(bytes));
    if (code[0] !== 'z' || typeof DecompressionStream === 'undefined') throw new Error('unsupported link');
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    return JSON.parse(new TextDecoder().decode(out));
  }

  let saveTimer = null, lastHash = '';
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        lastHash = '#s=' + await encodeState(getState());
        history.replaceState(null, '', lastHash);
      } catch (e) { /* URL state is a convenience: ignore errors */ }
    }, 300);
  }
  async function loadHash() {
    const m = /^#s=([A-Za-z0-9_-]+)$/.exec(location.hash);
    if (!m || location.hash === lastHash) return false;
    try { applyState(cleanState(await decodeState(m[1]))); lastHash = location.hash; return true; }
    catch (e) { flash('Could not read the link: ' + e.message); return false; }
  }
  function flash(msg) {
    const f = $('flash');
    f.textContent = msg;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { f.textContent = ''; }, 5000);
  }

  $('exp').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(getState(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `factorio-plan-${$('item').value || 'plan'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('imp').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
      if (f.size > 5e6) throw new Error('file is too large');
      applyState(cleanState(JSON.parse(await f.text())));
      flash('Imported ' + f.name);
    } catch (e) { flash('Import failed: ' + e.message); }
  });
  $('lnk').addEventListener('click', async () => {
    try {
      const frag = '#s=' + await encodeState(getState());
      history.replaceState(null, '', frag);
      lastHash = frag;
      await navigator.clipboard.writeText(location.href);
      flash(`Link copied (${location.href.length} characters)`);
    } catch (e) { flash('Copy failed. Copy the address bar instead.'); }
  });
  window.addEventListener('hashchange', loadHash);

  // About dialog. The data version comes from the trimmed data.
  $('aboutdata').textContent = 'Game data: Factorio ' + (data._meta.source_game_version || 'version unknown') + ' with Space Age, no mods.';
  $('aboutbtn').addEventListener('click', () => $('about').showModal());
  $('item').addEventListener('change', () => { selected = null; });
  $('viewmode').addEventListener('change', (ev) => { cfg.view = ev.target.value; selected = null; run(); });
  // Sources: any planet (Nauvis preferred) or one planet only.
  $('src').innerHTML = '<option value="">Any planet</option>' +
    FPGroups.planetNames(data).map((p) => `<option value="${p}">${pretty(p)} only</option>`).join('');
  $('src').addEventListener('change', (ev) => { cfg.source = ev.target.value; run(); });
  for (const id of ['item', 'rate', 'unit']) $(id).addEventListener('change', run);
  settingsPanel();
  $('labels').addEventListener('change', () => lay && draw(false));
  $('item').value = 'chemical-science-pack';
  loadHash().then((ok) => { if (!ok) run(); });
  window.__fp = { run, get plan() { return plan; } };
})();
