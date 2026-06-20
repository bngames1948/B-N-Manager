// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  customers: [], locations: [], machines: [], baselineReadings: {},
  periods: [], readings: [], atmRefills: [], tasks: [],
  currentTab: 'dashboard',
  navStack: [],            // [{ tab, render }] for back-button support
  activePeriodId: null,
  ws: null,
  wsConnected: false
};

// ─── API helpers ──────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000); // 20s timeout
  try {
    const res = await fetch(path, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Server took too long — try again');
    throw e;
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let _toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

// ─── Format helpers ───────────────────────────────────────────────────────────
const fmt = n => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const str = abs >= 1000 ? '$' + (abs / 1000).toFixed(1) + 'k' : '$' + abs.toFixed(0);
  return n < 0 ? '-' + str : str;
};
const fmtFull = n => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const posClass = n => n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu';

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.onopen = () => {
    state.wsConnected = true;
    const dot = document.getElementById('conn-dot');
    if (dot) { dot.classList.remove('offline'); }
  };

  ws.onmessage = e => {
    const { event, payload } = JSON.parse(e.data);
    switch (event) {
      case 'reading_saved':
        state.readings = state.readings.filter(r => r.id !== payload.id);
        state.readings.push(payload);
        break;
      case 'reading_deleted':
        state.readings = state.readings.filter(r => r.id !== payload.id);
        break;
      case 'atm_refill_saved':
        state.atmRefills = state.atmRefills.filter(r => r.id !== payload.id);
        state.atmRefills.push(payload);
        break;
      case 'task_added':
        if (!state.tasks.find(t => t.id === payload.id)) state.tasks.push(payload);
        break;
      case 'task_updated':
        { const i = state.tasks.findIndex(t => t.id === payload.id);
          if (i >= 0) state.tasks[i] = payload; }
        break;
      case 'task_deleted':
        state.tasks = state.tasks.filter(t => t.id !== payload.id);
        break;
      case 'period_created':
        if (!state.periods.find(p => p.id === payload.id)) state.periods.unshift(payload);
        state.activePeriodId = payload.id;
        break;
      case 'period_updated':
        { const i = state.periods.findIndex(p => p.id === payload.id);
          if (i >= 0) state.periods[i] = payload; }
        break;
    }
    // Re-render current view
    App.refresh();
  };

  ws.onclose = () => {
    state.wsConnected = false;
    const dot = document.getElementById('conn-dot');
    if (dot) dot.classList.add('offline');
    setTimeout(connectWS, 3000);
  };
  ws.onerror = () => ws.close();
}

// ─── Data loading ─────────────────────────────────────────────────────────────
async function loadAll() {
  const [config, periods] = await Promise.all([
    api('GET', '/api/config'),
    api('GET', '/api/periods')
  ]);
  Object.assign(state, config);
  state.periods = periods;
  state.activePeriodId = periods.find(p => p.status === 'active')?.id || null;

  if (state.activePeriodId) {
    const [readings, atmRefills, tasks] = await Promise.all([
      api('GET', `/api/periods/${state.activePeriodId}/readings`),
      api('GET', `/api/periods/${state.activePeriodId}/atm-refills`),
      api('GET', `/api/tasks?periodId=${state.activePeriodId}`)
    ]);
    state.readings  = readings;
    state.atmRefills = atmRefills;
    state.tasks     = tasks;
  } else {
    const tasks = await api('GET', '/api/tasks');
    state.tasks = tasks;
  }
}

// ─── Computed helpers ─────────────────────────────────────────────────────────
function activePeriod() {
  return state.periods.find(p => p.id === state.activePeriodId) || null;
}

function locationMachines(locationId) {
  return state.machines
    .filter(m => m.locationId === locationId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function locationReadings(locationId, periodId) {
  const machineIds = locationMachines(locationId).map(m => m.id);
  const pid = periodId || state.activePeriodId;
  return state.readings.filter(r => machineIds.includes(r.machineId) && r.periodId === pid);
}

function locationAtmRefill(locationId, periodId) {
  const pid = periodId || state.activePeriodId;
  return state.atmRefills.find(r => r.locationId === locationId && r.periodId === pid) || null;
}

function isLocationDone(locationId) {
  const machines = locationMachines(locationId);
  const readings = locationReadings(locationId);
  return machines.every(m => readings.some(r => r.machineId === m.id));
}

function locationProfit(locationId, periodId) {
  return locationReadings(locationId, periodId).reduce((s, r) => s + r.weekSum, 0);
}

function readingFor(machineId, periodId) {
  const pid = periodId || state.activePeriodId;
  return state.readings.find(r => r.machineId === machineId && r.periodId === pid) || null;
}

function oldValueFor(machineId) {
  const prev = state.readings
    .filter(r => r.machineId === machineId && r.periodId !== state.activePeriodId)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))[0];
  if (prev) return { in: prev.lifetimeIn, out: prev.lifetimeOut };
  return state.baselineReadings[machineId] || { in: 0, out: 0 };
}

function totalDone() {
  return state.locations.filter(l => isLocationDone(l.id)).length;
}

function openTasks() {
  return state.tasks.filter(t => !t.completed);
}

// ─── App Controller ───────────────────────────────────────────────────────────
const App = {
  _currentRender: null,

  showTab(tab) {
    state.currentTab = tab;
    state.navStack   = [];
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('back-btn').classList.add('hidden');
    document.getElementById('header-action').innerHTML = '';
    this._renderTab(tab);
  },

  _renderTab(tab) {
    const renders = {
      dashboard: renderDashboard,
      locations: renderLocations,
      tasks:     renderTasks,
      summary:   renderSummary
    };
    const fn = renders[tab];
    if (fn) { this._currentRender = fn; fn(); }
  },

  push(renderFn, title) {
    state.navStack.push({ render: this._currentRender, title: document.getElementById('page-title').textContent });
    this._currentRender = renderFn;
    document.getElementById('back-btn').classList.remove('hidden');
    renderFn();
  },

  goBack() {
    if (!state.navStack.length) return;
    const prev = state.navStack.pop();
    this._currentRender = prev.render;
    document.getElementById('page-title').textContent = prev.title;
    if (!state.navStack.length) document.getElementById('back-btn').classList.add('hidden');
    document.getElementById('header-action').innerHTML = '';
    prev.render();
  },

  refresh() {
    if (this._currentRender) this._currentRender();
  }
};

// ─── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard() {
  document.getElementById('page-title').textContent = 'B&N Manager';
  document.getElementById('header-action').innerHTML =
    `<span id="conn-dot"${state.wsConnected ? '' : ' class="offline"'}></span>`;

  const period = activePeriod();
  const done   = totalDone();
  const total  = state.locations.length;
  const pct    = total ? Math.round((done / total) * 100) : 0;
  const totalProfit = state.locations.reduce((s, l) => s + locationProfit(l.id), 0);
  const openCount   = openTasks().length;

  let html = `<div class="page">`;

  if (!period) {
    html += `
    <div class="empty-state">
      <div class="empty-icon">📋</div>
      <h3>No Active Period</h3>
      <p>Start a new biweekly period to begin entering machine readings.</p>
    </div>
    <button class="btn btn-primary" style="margin:0 16px;width:calc(100% - 32px)" onclick="startNewPeriod()">
      + Start New Period
    </button>`;
  } else {
    html += `
    <div class="hero">
      <div class="hero-title">Current Period</div>
      <div class="hero-period">${period.label}</div>
      <div class="hero-stats">
        <div class="hero-stat ${done === total ? 'green' : 'orange'}">
          <div class="val">${done}/${total}</div>
          <div class="lbl">Locations Done</div>
        </div>
        <div class="hero-stat green">
          <div class="val">${fmt(totalProfit)}</div>
          <div class="lbl">Total Profit</div>
        </div>
        ${openCount > 0 ? `<div class="hero-stat orange"><div class="val">${openCount}</div><div class="lbl">Open Tasks</div></div>` : ''}
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar" style="width:${pct}%"></div>
      </div>
    </div>`;

    // Quick location list grouped by customer
    const customers = state.customers;
    customers.forEach(cust => {
      const locs = state.locations.filter(l => l.customerId === cust.id);
      if (!locs.length) return;
      html += `<div class="section-title">${cust.name}</div><div class="card">`;
      locs.forEach(loc => {
        const done    = isLocationDone(loc.id);
        const profit  = locationProfit(loc.id);
        const atm     = locationAtmRefill(loc.id);
        const machines = locationMachines(loc.id);
        const readCount = locationReadings(loc.id).length;
        html += `
        <div class="card-row" onclick="App.push(() => renderLocation('${loc.id}'), '${loc.name}')">
          <span class="icon">${done ? '✅' : '⏳'}</span>
          <div class="row-content">
            <div class="row-title">${loc.name}</div>
            <div class="row-sub">${readCount}/${machines.length} machines${atm ? ` · ATM $${atm.amount}` : (loc.hasAtm ? ' · ATM pending' : '')}</div>
          </div>
          <div class="row-right">
            ${profit !== 0 ? `<div style="font-weight:700;color:${profit >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(profit)}</div>` : ''}
          </div>
          <span class="chevron">›</span>
        </div>`;
      });
      html += `</div>`;
    });

    html += `
    <div style="margin-top:8px">
      <button class="btn btn-secondary" onclick="startNewPeriod()">Start New Period (closes current)</button>
    </div>`;
  }

  html += `</div>`;
  document.getElementById('main-content').innerHTML = html;
}

function startNewPeriod() {
  const current = activePeriod();
  const done    = totalDone();
  const total   = state.locations.length;

  const overlay = document.createElement('div');
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;z-index:999;padding:16px;`;

  const currentLabel = current ? current.label : 'None';
  const now = new Date();
  const newLabel = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:16px;width:100%;padding:20px">
      <div style="font-size:17px;font-weight:700;margin-bottom:6px">Start New Period?</div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:16px">
        Current: <strong style="color:var(--text)">${currentLabel}</strong><br>
        ${done}/${total} locations completed${current ? ' — data is saved to history' : ''}
      </div>
      ${current ? `
      <button class="btn btn-secondary" style="margin-bottom:10px" onclick="generatePDF('${current.id}');this.textContent='Generating…'">
        📄 Save Current Period as PDF First
      </button>` : ''}
      <button class="btn btn-primary" style="margin-bottom:10px" onclick="confirmNewPeriod('${newLabel}',this)">
        ✅ Complete &amp; Start New Period
      </button>
      <button class="btn btn-secondary" onclick="this.closest('div[style*=fixed]').remove()">
        Cancel
      </button>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

async function confirmNewPeriod(label, btn) {
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    const period = await api('POST', '/api/periods', { label });
    state.periods.unshift(period);
    state.activePeriodId = period.id;
    state.readings   = [];
    state.atmRefills = [];
    document.querySelector('div[style*="position:fixed"]')?.remove();
    toast('New period started — numbers cleared!');
    renderDashboard();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '✅ Complete & Start New Period';
    toast('Error: ' + e.message);
  }
}

// ─── Locations List ───────────────────────────────────────────────────────────
function renderLocations() {
  document.getElementById('page-title').textContent = 'Locations';
  document.getElementById('header-action').innerHTML = '';
  const period = activePeriod();
  let html = `<div class="page">`;

  if (!period) {
    html += `<div class="empty-state"><div class="empty-icon">📍</div><h3>No Active Period</h3><p>Start a period from the Home tab first.</p></div>`;
  } else {
    state.customers.forEach(cust => {
      const locs = state.locations.filter(l => l.customerId === cust.id);
      if (!locs.length) return;
      html += `<div class="section-title">${cust.name}</div><div class="card">`;
      locs.forEach(loc => {
        const done     = isLocationDone(loc.id);
        const machines = locationMachines(loc.id);
        const readCount = locationReadings(loc.id).length;
        const profit   = locationProfit(loc.id);
        html += `
        <div class="card-row" onclick="App.push(() => renderLocation('${loc.id}'), '${loc.name}')">
          <span class="icon">${done ? '✅' : '📍'}</span>
          <div class="row-content">
            <div class="row-title">${loc.name}</div>
            <div class="row-sub">${readCount}/${machines.length} machines · ${loc.splitPercent}% split${loc.hasAtm ? ' · ATM' : ''}</div>
          </div>
          <div class="row-right">
            ${profit !== 0 ? `<span style="font-weight:700;color:${profit >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(profit)}</span>` : ''}
          </div>
          <span class="chevron">›</span>
        </div>`;
      });
      html += `</div>`;
    });
  }

  html += `</div>`;
  document.getElementById('main-content').innerHTML = html;
}

// ─── Location Detail ──────────────────────────────────────────────────────────
function renderLocation(locationId) {
  const loc     = state.locations.find(l => l.id === locationId);
  const machines = locationMachines(locationId);
  const atm     = locationAtmRefill(locationId);
  const period  = activePeriod();

  document.getElementById('page-title').textContent = loc.name;
  document.getElementById('header-action').innerHTML = '';

  let html = `<div class="page">`;

  // Machines
  html += `<div class="section-title">Machines</div>`;
  machines.forEach(m => {
    const reading = readingFor(m.id);
    const old     = oldValueFor(m.id);

    html += `<div class="machine-card" id="mc-${m.id}">
      <div class="machine-header">
        <span class="machine-id">${m.id}</span>
        <span class="machine-type">${m.gameType}</span>
        ${reading ? `<span class="badge badge-green">✓ Saved</span>` : `<span class="badge badge-orange">Pending</span>`}
      </div>
      ${m.permanentNote ? `<div class="machine-note">⚠️ ${m.permanentNote}</div>` : ''}
      <div class="machine-inputs">
        <div class="input-row">
          <span class="input-label">OLD IN</span>
          <input type="number" disabled value="${old.in}" style="color:var(--text2)">
        </div>
        <div class="input-row">
          <span class="input-label">NEW IN</span>
          <input type="number" id="in-${m.id}" placeholder="Enter meter" value="${reading ? reading.lifetimeIn : ''}"
            oninput="calcMachine('${m.id}', ${old.in}, ${old.out})">
        </div>
        <div class="input-row">
          <span class="input-label">OLD OUT</span>
          <input type="number" disabled value="${old.out}" style="color:var(--text2)">
        </div>
        <div class="input-row">
          <span class="input-label">NEW OUT</span>
          <input type="number" id="out-${m.id}" placeholder="Enter meter" value="${reading ? reading.lifetimeOut : ''}"
            oninput="calcMachine('${m.id}', ${old.in}, ${old.out})">
        </div>
        <div class="input-row">
          <span class="input-label">Notes</span>
          <input type="text" id="note-${m.id}" placeholder="Optional note" value="${reading ? reading.notes : ''}">
        </div>
      </div>
      <div class="calc-row" id="calc-${m.id}">
        <div class="calc-item">
          <div class="clbl">Week IN</div>
          <div class="cval neu" id="wi-${m.id}">${reading ? fmt(reading.weekIn) : '—'}</div>
        </div>
        <div class="calc-item">
          <div class="clbl">Week OUT</div>
          <div class="cval neu" id="wo-${m.id}">${reading ? fmt(reading.weekOut) : '—'}</div>
        </div>
        <div class="calc-item">
          <div class="clbl">Profit</div>
          <div class="cval ${reading ? posClass(reading.weekSum) : 'neu'}" id="ws-${m.id}">${reading ? fmt(reading.weekSum) : '—'}</div>
        </div>
      </div>
      <div style="padding:12px 16px">
        <button class="btn btn-primary btn-sm" onclick="saveMachineReading('${m.id}', '${locationId}', ${old.in}, ${old.out})">
          Save Reading
        </button>
      </div>
    </div>`;
  });

  // ATM section
  if (loc.hasAtm) {
    const amounts = [500, 1000, 1500, 2000, 2500, 3000];
    const selected = atm ? atm.amount : null;
    html += `
    <div class="section-title">ATM / Kiosk Refill</div>
    <div class="atm-section">
      <div class="atm-header">
        <span class="atm-title">💵 ATM Refill</span>
        ${atm ? `<span class="badge badge-green">$${atm.amount.toLocaleString()} Refilled</span>` : `<span class="badge badge-orange">Not Refilled</span>`}
      </div>
      <div class="atm-body">
        <div>
          <div style="font-size:13px;color:var(--text2);margin-bottom:8px">Select refill amount:</div>
          <div class="amount-grid" id="atm-amounts-${loc.id}">
            ${amounts.map(a => `
              <div class="amount-btn${selected === a ? ' selected' : ''}"
                onclick="selectAtmAmount('${loc.id}', ${a})">
                $${a.toLocaleString()}
              </div>`).join('')}
            <div class="amount-btn${selected && !amounts.includes(selected) ? ' selected' : ''}"
              onclick="customAtmAmount('${loc.id}')">
              Custom
            </div>
          </div>
        </div>
        <div class="input-row">
          <span class="input-label">Short $</span>
          <input type="number" id="short-${loc.id}" placeholder="0" value="${atm ? atm.shortAmount : 0}">
        </div>
        <div class="input-row">
          <span class="input-label">Notes</span>
          <input type="text" id="atm-note-${loc.id}" placeholder="Optional" value="${atm ? atm.notes : ''}">
        </div>
        <div id="atm-selected-display-${loc.id}" style="font-size:13px;color:var(--text2)">
          ${selected ? `Selected: <strong style="color:var(--blue)">$${selected.toLocaleString()}</strong>` : 'No amount selected'}
        </div>
        <button class="btn btn-primary" id="atm-save-btn-${loc.id}" onclick="saveAtmRefill('${loc.id}')">
          Save ATM Refill
        </button>
      </div>
    </div>`;
  }

  // Notes / Tasks for this location
  const locTasks = state.tasks.filter(t => t.locationId === locationId);
  html += `
  <div class="section-title">Location Notes & Tasks</div>
  <div class="card">
    ${locTasks.length === 0 ? `<div style="padding:14px 16px;color:var(--text2);font-size:14px">No tasks yet</div>` : ''}
    ${locTasks.map(t => `
    <div class="task-item">
      <button class="task-check${t.completed ? ' done' : ''}" onclick="toggleTask('${t.id}')">
        ${t.completed ? '✓' : ''}
      </button>
      <div class="task-content">
        <div class="task-text${t.completed ? ' done' : ''}">${t.text}</div>
      </div>
      <button class="task-del" onclick="deleteTask('${t.id}')">×</button>
    </div>`).join('')}
    <div class="add-task-row">
      <input type="text" id="new-task-${locationId}" placeholder="Add a note or task…">
      <button class="add-task-btn" onclick="addTask('${locationId}', '${loc.name}')">Add</button>
    </div>
  </div>

  <div style="margin-top:16px;margin-bottom:8px">
    <div style="font-size:13px;color:var(--text2);margin-bottom:8px;padding:0 2px">
      Location split: <strong>${loc.splitPercent}%</strong> to ${loc.name.split(' - ')[0]} ·
      <strong>${100 - loc.splitPercent}%</strong> to B&N
    </div>
  </div>`;

  html += `</div>`;
  document.getElementById('main-content').innerHTML = html;

  // Set ATM custom amount if needed
  if (loc.hasAtm && atm && ![500,1000,1500,2000,2500,3000].includes(atm.amount)) {
    window._atmCustomAmounts = window._atmCustomAmounts || {};
    window._atmCustomAmounts[loc.id] = atm.amount;
  }
}

// ─── Machine calculation (live) ───────────────────────────────────────────────
function calcMachine(machineId, oldIn, oldOut) {
  const inVal  = parseFloat(document.getElementById(`in-${machineId}`)?.value)  || 0;
  const outVal = parseFloat(document.getElementById(`out-${machineId}`)?.value) || 0;
  const weekIn  = inVal  - oldIn;
  const weekOut = outVal - oldOut;
  const weekSum = weekIn - weekOut;

  const wi = document.getElementById(`wi-${machineId}`);
  const wo = document.getElementById(`wo-${machineId}`);
  const ws = document.getElementById(`ws-${machineId}`);
  if (wi) { wi.textContent = fmt(weekIn);  wi.className = `cval ${posClass(weekIn)}`; }
  if (wo) { wo.textContent = fmt(weekOut); wo.className = `cval ${posClass(weekOut)}`; }
  if (ws) { ws.textContent = fmt(weekSum); ws.className = `cval ${posClass(weekSum)}`; }
}

async function saveMachineReading(machineId, locationId, oldIn, oldOut) {
  const inEl   = document.getElementById(`in-${machineId}`);
  const outEl  = document.getElementById(`out-${machineId}`);
  const noteEl = document.getElementById(`note-${machineId}`);
  const period = activePeriod();
  if (!period)   { toast('No active period'); return; }
  if (!inEl?.value || !outEl?.value) { toast('Enter both IN and OUT values'); return; }

  try {
    const r = await api('POST', '/api/readings', {
      periodId:    period.id,
      machineId,
      lifetimeIn:  parseFloat(inEl.value),
      lifetimeOut: parseFloat(outEl.value),
      notes:       noteEl?.value || ''
    });
    state.readings = state.readings.filter(x => !(x.machineId === machineId && x.periodId === period.id));
    state.readings.push(r);
    toast(`${machineId} saved!`);
    renderLocation(locationId);
  } catch(e) { toast('Error: ' + e.message); }
}

// ─── ATM refill ───────────────────────────────────────────────────────────────
window._atmSelectedAmounts = {};

function selectAtmAmount(locationId, amount) {
  window._atmSelectedAmounts[locationId] = amount;
  document.querySelectorAll(`#atm-amounts-${locationId} .amount-btn`).forEach(b => {
    b.classList.toggle('selected', b.textContent.trim() === `$${amount.toLocaleString()}`);
  });
  const disp = document.getElementById(`atm-selected-display-${locationId}`);
  if (disp) disp.innerHTML = `Selected: <strong style="color:var(--blue)">$${amount.toLocaleString()}</strong>`;
}

function customAtmAmount(locationId) {
  const amt = prompt('Enter custom ATM refill amount ($):');
  if (!amt || isNaN(Number(amt))) return;
  const amount = Number(amt);
  window._atmSelectedAmounts[locationId] = amount;
  document.querySelectorAll(`#atm-amounts-${locationId} .amount-btn`).forEach(b => b.classList.remove('selected'));
  const customBtn = [...document.querySelectorAll(`#atm-amounts-${locationId} .amount-btn`)].find(b => b.textContent.trim() === 'Custom');
  if (customBtn) customBtn.classList.add('selected');
  const disp = document.getElementById(`atm-selected-display-${locationId}`);
  if (disp) disp.innerHTML = `Selected: <strong style="color:var(--blue)">$${amount.toLocaleString()}</strong>`;
}

async function saveAtmRefill(locationId) {
  const period = activePeriod();
  if (!period) { toast('No active period'); return; }

  const amount = window._atmSelectedAmounts[locationId];
  if (!amount) { toast('Select a refill amount'); return; }

  const shortEl = document.getElementById(`short-${locationId}`);
  const noteEl  = document.getElementById(`atm-note-${locationId}`);
  try {
    const r = await api('POST', '/api/atm-refills', {
      periodId:    period.id,
      locationId,
      amount,
      shortAmount: parseFloat(shortEl?.value) || 0,
      notes:       noteEl?.value || ''
    });
    state.atmRefills = state.atmRefills.filter(x => !(x.locationId === locationId && x.periodId === period.id));
    state.atmRefills.push(r);
    toast('ATM refill saved!');
    renderLocation(locationId);
  } catch(e) { toast('Error: ' + e.message); }
}

// ─── Tasks ────────────────────────────────────────────────────────────────────
function renderTasks() {
  document.getElementById('page-title').textContent = 'Tasks & Notes';
  document.getElementById('header-action').innerHTML = '';

  const period    = activePeriod();
  const tasks     = state.tasks.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const byLoc = {};
  tasks.forEach(t => {
    const key = t.locationName || 'General';
    if (!byLoc[key]) byLoc[key] = [];
    byLoc[key].push(t);
  });

  let html = `<div class="page">`;

  const open   = tasks.filter(t => !t.completed).length;
  const closed = tasks.filter(t =>  t.completed).length;
  html += `
  <div style="display:flex;gap:8px;margin-bottom:12px">
    <span class="badge badge-orange">${open} open</span>
    <span class="badge badge-green">${closed} done</span>
  </div>`;

  if (tasks.length === 0) {
    html += `<div class="empty-state"><div class="empty-icon">✅</div><h3>All Clear!</h3><p>No tasks or notes yet. Add them from a location page.</p></div>`;
  } else {
    Object.entries(byLoc).forEach(([locName, locTasks]) => {
      html += `<div class="section-title">${locName}</div><div class="card">`;
      locTasks.forEach(t => {
        html += `
        <div class="task-item">
          <button class="task-check${t.completed ? ' done' : ''}" onclick="toggleTask('${t.id}')">
            ${t.completed ? '✓' : ''}
          </button>
          <div class="task-content">
            <div class="task-text${t.completed ? ' done' : ''}">${t.text}</div>
          </div>
          <button class="task-del" onclick="deleteTask('${t.id}')">×</button>
        </div>`;
      });
      html += `</div>`;
    });
  }

  // Add general task
  html += `
  <div class="section-title">Add General Task</div>
  <div class="card">
    <div class="add-task-row">
      <input type="text" id="new-task-general" placeholder="Add a task…">
      <button class="add-task-btn" onclick="addTask(null, 'General')">Add</button>
    </div>
  </div>`;

  html += `</div>`;
  document.getElementById('main-content').innerHTML = html;
}

async function addTask(locationId, locationName) {
  const inputId = locationId ? `new-task-${locationId}` : 'new-task-general';
  const input   = document.getElementById(inputId);
  const text    = input?.value?.trim();
  if (!text) return;
  const period = activePeriod();
  try {
    const t = await api('POST', '/api/tasks', {
      periodId:     period?.id || null,
      locationId:   locationId || null,
      locationName: locationName || '',
      text
    });
    state.tasks.push(t);
    input.value = '';
    toast('Task added');
    App.refresh();
  } catch(e) { toast('Error: ' + e.message); }
}

async function toggleTask(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  try {
    const updated = await api('PUT', `/api/tasks/${taskId}`, { completed: !task.completed });
    const i = state.tasks.findIndex(t => t.id === taskId);
    if (i >= 0) state.tasks[i] = updated;
    App.refresh();
  } catch(e) { toast('Error: ' + e.message); }
}

async function deleteTask(taskId) {
  try {
    await api('DELETE', `/api/tasks/${taskId}`);
    state.tasks = state.tasks.filter(t => t.id !== taskId);
    toast('Task removed');
    App.refresh();
  } catch(e) { toast('Error: ' + e.message); }
}

// ─── Summary ──────────────────────────────────────────────────────────────────
let _summaryData    = null;
let _summaryPeriodId = null;

async function renderSummary() {
  document.getElementById('page-title').textContent = 'Summary';
  document.getElementById('header-action').innerHTML = '';

  const periods    = state.periods;
  const periodId   = _summaryPeriodId || state.activePeriodId || (periods[0]?.id);
  _summaryPeriodId = periodId;

  let html = `<div class="page">`;

  if (!periods.length) {
    html += `<div class="empty-state"><div class="empty-icon">📊</div><h3>No Data Yet</h3><p>Start a period and enter readings first.</p></div>`;
    document.getElementById('main-content').innerHTML = html + `</div>`;
    return;
  }

  html += `<select class="period-select" onchange="changeSummaryPeriod(this.value)">`;
  periods.forEach(p => {
    html += `<option value="${p.id}"${p.id === periodId ? ' selected' : ''}>${p.label}${p.status === 'active' ? ' (Active)' : ''}</option>`;
  });
  html += `</select>`;

  html += `<div id="summary-body">Loading…</div>`;
  document.getElementById('main-content').innerHTML = html + `</div>`;

  try {
    _summaryData = await api('GET', `/api/summary/${periodId}`);
    renderSummaryBody(_summaryData, periodId);
  } catch(e) {
    document.getElementById('summary-body').innerHTML = `<p style="color:var(--red)">Error loading summary</p>`;
  }
}

function changeSummaryPeriod(id) {
  _summaryPeriodId = id;
  renderSummary();
}

function renderSummaryBody(data, periodId) {
  const period = state.periods.find(p => p.id === periodId);
  let html = '';

  const grandTotal    = data.reduce((s, c) => s + c.totalGross, 0);
  const grandOurs     = data.reduce((s, c) => s + c.totalOurs, 0);
  html += `
  <div class="card" style="padding:16px;margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div>
        <div style="font-size:12px;color:var(--text2)">Total Gross Profit</div>
        <div style="font-size:22px;font-weight:800;color:var(--text)">${fmtFull(grandTotal)}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:12px;color:var(--text2)">B&N Share</div>
        <div style="font-size:22px;font-weight:800;color:var(--green)">${fmtFull(grandOurs)}</div>
      </div>
    </div>
    <button class="btn btn-primary" id="pdf-btn-${periodId}" onclick="generatePDF('${periodId}')">
      📄 Save Full Report as PDF
    </button>
    ${period?.status === 'active' ? `
    <div style="height:8px"></div>
    <button class="btn btn-secondary" onclick="startNewPeriod()">
      🔄 Complete Period &amp; Start Fresh
    </button>` : ''}
  </div>`;

  data.forEach(cust => {
    if (!cust.locations.length) return;
    const hasData = cust.locations.some(l => l.machines.some(m => m.reading));
    html += `
    <div class="customer-card">
      <div class="customer-header" onclick="toggleCustomerDetail('${cust.customer.id}')">
        <div>
          <div class="customer-name">${cust.customer.name}</div>
          <div style="font-size:13px;color:var(--text2)">${cust.locations.length} locations · ${hasData ? 'data entered' : 'no data yet'}</div>
        </div>
        <div>
          <div class="customer-total">${fmtFull(cust.totalCustomer)}</div>
          <div style="font-size:11px;color:var(--text2);text-align:right">their share</div>
        </div>
      </div>
      <div class="customer-detail" id="detail-${cust.customer.id}">`;

    cust.locations.forEach(ls => {
      const machineLines = ls.machines.map(({ machine: m, reading: r }) => {
        if (!r) return `<span style="color:var(--text2)">${m.id} (${m.gameType}): pending</span>`;
        return `${m.id} (${m.gameType}): +${fmt(r.weekIn)} in / -${fmt(r.weekOut)} out = <strong>${fmt(r.weekSum)}</strong>`;
      }).join('<br>');

      html += `
      <div class="loc-row">
        <div class="loc-name">${ls.location.name} <span style="color:var(--text2);font-size:12px">(${ls.location.splitPercent}% split)</span></div>
        <div class="loc-machines">${machineLines}</div>
        ${ls.atmRefill ? `<div style="font-size:12px;color:var(--blue);margin-bottom:6px">💵 ATM Refill: $${ls.atmRefill.amount.toLocaleString()}${ls.atmRefill.shortAmount ? ` · Short: $${ls.atmRefill.shortAmount}` : ''}</div>` : ''}
        <div class="loc-footer">
          <span class="loc-gross">Gross: ${fmtFull(ls.grossProfit)}</span>
          <span class="loc-share${ls.customerShare < 0 ? ' neg' : ''}">${ls.location.name.split(' - ')[0]}: ${fmtFull(ls.customerShare)}</span>
        </div>
      </div>`;
    });

    html += `
      <div style="padding:12px 16px;background:var(--surface2);border-top:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;margin-bottom:10px">
          <div>
            <div style="font-size:12px;color:var(--text2)">Total Gross</div>
            <div style="font-weight:700">${fmtFull(cust.totalGross)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:12px;color:var(--text2)">${cust.customer.name}'s Share</div>
            <div style="font-weight:700;color:var(--green)">${fmtFull(cust.totalCustomer)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:12px;color:var(--text2)">B&N Share</div>
            <div style="font-weight:700;color:var(--blue)">${fmtFull(cust.totalOurs)}</div>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="showMessage('${cust.customer.id}', '${period?.label || ''}')">
          📋 Generate Message for ${cust.customer.name}
        </button>
      </div>
      </div>
    </div>`;
  });

  document.getElementById('summary-body').innerHTML = html;
}

function toggleCustomerDetail(customerId) {
  const el = document.getElementById(`detail-${customerId}`);
  if (el) el.classList.toggle('open');
}

function showMessage(customerId, periodLabel) {
  const cust = _summaryData?.find(c => c.customer.id === customerId);
  if (!cust) return;
  const msg = generateMessage(cust, periodLabel);

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.85);
    display:flex;align-items:flex-end;z-index:999;padding:16px;
  `;
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:16px 16px 12px 12px;width:100%;max-height:80vh;overflow-y:auto;padding:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div style="font-size:16px;font-weight:700">Message for ${cust.customer.name}</div>
        <button onclick="this.closest('div[style]').remove()"
          style="background:none;border:none;color:var(--text2);font-size:24px;cursor:pointer">×</button>
      </div>
      <div class="msg-box" id="msg-preview">${msg}</div>
      <div class="copy-feedback" id="copy-fb"></div>
      <button class="btn btn-primary" onclick="copyMessage('msg-preview','copy-fb')">Copy Message</button>
      <div style="height:8px"></div>
      <a href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank"
        style="display:block;text-align:center;padding:12px;background:#25D366;border-radius:12px;color:#fff;font-weight:700;text-decoration:none">
        Share via WhatsApp
      </a>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function generateMessage(custData, periodLabel) {
  const name = custData.customer.name;
  const now  = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  let msg = `🎰 B&N Gaming Solutions\n`;
  msg    += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg    += `📅 Period: ${periodLabel}\n`;
  msg    += `📆 Generated: ${now}\n\n`;
  msg    += `Hello ${name},\n\n`;
  msg    += `Here is your earnings summary for this period:\n\n`;

  custData.locations.forEach(ls => {
    const hasReadings = ls.machines.some(m => m.reading);
    if (!hasReadings) return;
    msg += `📍 ${ls.location.name}\n`;
    ls.machines.forEach(({ machine: m, reading: r }) => {
      if (!r) return;
      msg += `   • ${m.gameType}: ${fmtFull(r.weekSum)}\n`;
    });
    msg += `   ▸ Location Profit: ${fmtFull(ls.grossProfit)}\n`;
    msg += `   ▸ Your ${ls.location.splitPercent}% Share: ${fmtFull(ls.customerShare)}\n\n`;
  });

  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💰 TOTAL GROSS PROFIT:  ${fmtFull(custData.totalGross)}\n`;
  msg += `💵 YOUR TOTAL EARNINGS: ${fmtFull(custData.totalCustomer)}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `Thank you for your continued partnership! 🤝\n`;
  msg += `— B&N Gaming Solutions`;
  return msg;
}

function copyMessage(previewId, feedbackId) {
  const text = document.getElementById(previewId)?.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    const fb = document.getElementById(feedbackId);
    if (fb) { fb.textContent = '✓ Copied to clipboard!'; setTimeout(() => fb.textContent = '', 2500); }
  }).catch(() => toast('Could not copy'));
}

// ─── PDF Generation ──────────────────────────────────────────────────────────
async function generatePDF(periodId) {
  const btn = document.getElementById(`pdf-btn-${periodId}`);
  if (btn) { btn.textContent = '⏳ Generating PDF…'; btn.disabled = true; }

  try {
    const data   = await api('GET', `/api/summary/${periodId}`);
    const period = state.periods.find(p => p.id === periodId);
    const { jsPDF } = window.jspdf;

    const doc  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pw   = doc.internal.pageSize.getWidth();
    const ph   = doc.internal.pageSize.getHeight();
    const mg   = 14;
    const cw   = pw - mg * 2;

    const C = {
      navy:    [22, 27, 34],
      navyMid: [33, 38, 45],
      green:   [63, 185, 80],
      blue:    [88, 166, 255],
      gray:    [139, 148, 158],
      lightBg: [246, 248, 250],
      white:   [255, 255, 255],
      black:   [0, 0, 0]
    };

    function addPageIfNeeded(needed) {
      if (y + needed > ph - 16) { doc.addPage(); y = 16; addPageFooter(); }
    }

    function addPageFooter() {
      const pageCount = doc.internal.getNumberOfPages();
      doc.setPage(pageCount);
      doc.setFontSize(8);
      doc.setTextColor(...C.gray);
      doc.text(`B&N Gaming Solutions  ·  ${period?.label || ''}  ·  Page ${pageCount}`, pw / 2, ph - 8, { align: 'center' });
    }

    // ── Cover header ──
    doc.setFillColor(...C.navy);
    doc.rect(0, 0, pw, 42, 'F');

    doc.setTextColor(...C.white);
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.text('B&N GAMING SOLUTIONS', mg, 16);

    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...C.blue);
    doc.text(`Period Report: ${period?.label || 'Unknown Period'}`, mg, 25);

    doc.setTextColor(...C.gray);
    doc.setFontSize(9);
    doc.text(`Generated: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`, mg, 33);

    let y = 52;

    // ── Grand totals bar ──
    const grandTotal = data.reduce((s, c) => s + c.totalGross, 0);
    const grandOurs  = data.reduce((s, c) => s + c.totalOurs, 0);

    doc.setFillColor(...C.navyMid);
    doc.roundedRect(mg, y, cw, 18, 3, 3, 'F');

    doc.setTextColor(...C.white);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('TOTAL GROSS PROFIT', mg + 4, y + 7);
    doc.text(fmtFull(grandTotal), mg + 4, y + 14);

    doc.setTextColor(...C.green);
    doc.text("B&N TOTAL SHARE", pw - mg - 4, y + 7, { align: 'right' });
    doc.text(fmtFull(grandOurs), pw - mg - 4, y + 14, { align: 'right' });

    y += 26;

    // ── Per-customer sections ──
    for (const custData of data) {
      const hasData = custData.locations.some(l => l.machines.some(m => m.reading));
      if (!hasData) continue;

      addPageIfNeeded(24);

      // Customer header band
      doc.setFillColor(...C.navy);
      doc.rect(mg, y, cw, 11, 'F');
      doc.setTextColor(...C.white);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text(`CUSTOMER: ${custData.customer.name}`, mg + 3, y + 7.5);

      doc.setTextColor(...C.green);
      doc.setFontSize(10);
      doc.text(fmtFull(custData.totalCustomer), pw - mg - 3, y + 7.5, { align: 'right' });
      y += 15;

      // Locations
      for (const ls of custData.locations) {
        const locHasData = ls.machines.some(m => m.reading);
        if (!locHasData) continue;

        addPageIfNeeded(30);

        // Location title
        doc.setTextColor(...C.navy);
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.text(`${ls.location.name}`, mg, y);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...C.gray);
        doc.setFontSize(9);
        doc.text(`(${ls.location.splitPercent}% to ${ls.location.name.split(' - ')[0]})`, mg + doc.getTextWidth(ls.location.name) + 3, y);
        y += 5;

        // Machine table
        const tableRows = ls.machines
          .filter(m => m.reading)
          .map(({ machine: m, reading: r }) => [
            m.id,
            m.gameType,
            fmtFull(r.lifetimeIn),
            fmtFull(r.lifetimeOut),
            fmtFull(r.weekIn),
            fmtFull(r.weekOut),
            fmtFull(r.weekSum)
          ]);

        doc.autoTable({
          startY: y,
          head: [['ID', 'Game', 'Lifetime IN', 'Lifetime OUT', 'Week IN', 'Week OUT', 'Profit']],
          body: tableRows,
          margin: { left: mg, right: mg },
          styles: { fontSize: 8, cellPadding: 2, textColor: C.black },
          headStyles: { fillColor: C.navyMid, textColor: C.white, fontStyle: 'bold', fontSize: 8 },
          alternateRowStyles: { fillColor: C.lightBg },
          columnStyles: {
            2: { halign: 'right' }, 3: { halign: 'right' },
            4: { halign: 'right' }, 5: { halign: 'right' },
            6: { halign: 'right', fontStyle: 'bold' }
          },
          didDrawCell: (d) => {
            // Green text for profit column
            if (d.section === 'body' && d.column.index === 6) {
              doc.setTextColor(...C.green);
            }
          }
        });

        y = doc.lastAutoTable.finalY + 3;

        // Location totals line
        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...C.gray);
        let totLine = `Location Gross: ${fmtFull(ls.grossProfit)}  ·  ${ls.location.name.split(' - ')[0]}'s ${ls.location.splitPercent}%: ${fmtFull(ls.customerShare)}  ·  B&N ${100 - ls.location.splitPercent}%: ${fmtFull(ls.ourShare)}`;
        if (ls.atmRefill) totLine += `  ·  ATM Refill: $${ls.atmRefill.amount.toLocaleString()}${ls.atmRefill.shortAmount ? ` (Short: $${ls.atmRefill.shortAmount})` : ''}`;
        doc.text(totLine, mg, y);
        y += 8;
      }

      // Customer totals bar
      addPageIfNeeded(14);
      doc.setFillColor(...C.lightBg);
      doc.rect(mg, y, cw, 11, 'F');
      doc.setTextColor(...C.navy);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text(`${custData.customer.name} GROSS: ${fmtFull(custData.totalGross)}`, mg + 3, y + 7);
      doc.setTextColor(...C.green);
      doc.text(`${custData.customer.name}'s Share: ${fmtFull(custData.totalCustomer)}  ·  B&N: ${fmtFull(custData.totalOurs)}`, pw - mg - 3, y + 7, { align: 'right' });
      y += 18;
    }

    // ── Final grand total footer ──
    addPageIfNeeded(20);
    doc.setFillColor(...C.navy);
    doc.rect(mg, y, cw, 18, 'F');
    doc.setTextColor(...C.white);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('GRAND TOTAL GROSS PROFIT', mg + 4, y + 8);
    doc.text(fmtFull(grandTotal), mg + 4, y + 15);
    doc.setTextColor(...C.green);
    doc.text(`B&N NET: ${fmtFull(grandOurs)}`, pw - mg - 4, y + 11.5, { align: 'right' });

    // Add footer to every page
    const totalPages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(...C.gray);
      doc.text(`B&N Gaming Solutions  ·  ${period?.label || ''}  ·  Page ${i} of ${totalPages}`, pw / 2, ph - 8, { align: 'center' });
    }

    // Save — on iOS this opens in Safari viewer, tap Share → Save to Files
    const filename = `BN-${(period?.label || 'Report').replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-')}.pdf`;
    doc.save(filename);
    toast('PDF saved! Tap Share → Save to Files on iPhone');
  } catch (e) {
    toast('PDF error: ' + e.message);
    console.error(e);
  } finally {
    if (btn) { btn.textContent = '📄 Save Full Report as PDF'; btn.disabled = false; }
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    await loadAll();
    connectWS();
    App.showTab('dashboard');
    App._currentRender = renderDashboard;
  } catch(e) {
    document.getElementById('main-content').innerHTML =
      `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Connection Error</h3><p>${e.message}</p></div>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
