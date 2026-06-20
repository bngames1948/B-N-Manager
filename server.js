const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/data/db.json'
  : path.join(__dirname, 'data', 'db.json');

// On first production deploy, seed the persistent disk with the bundled db
if (process.env.NODE_ENV === 'production' && !fs.existsSync(DB_PATH)) {
  fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), DB_PATH);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── DB helpers ──────────────────────────────────────────────────────────────

function readDb() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ─── WebSocket broadcast ──────────────────────────────────────────────────────

function broadcast(event, payload) {
  const msg = JSON.stringify({ event, payload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', ws => {
  ws.on('error', () => {});
});

// ─── API: Config (static data) ────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  const db = readDb();
  res.json({
    customers: db.customers,
    locations: db.locations,
    machines: db.machines,
    baselineReadings: db.baselineReadings
  });
});

// ─── API: Periods ─────────────────────────────────────────────────────────────

app.get('/api/periods', (req, res) => {
  const db = readDb();
  res.json(db.periods);
});

app.post('/api/periods', (req, res) => {
  const db = readDb();
  const { label } = req.body;

  // Close any active period
  db.periods.forEach(p => { if (p.status === 'active') p.status = 'completed'; });

  const period = {
    id: uuidv4(),
    label: label || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    createdAt: new Date().toISOString(),
    status: 'active'
  };
  db.periods.unshift(period);
  writeDb(db);
  broadcast('period_created', period);
  res.json(period);
});

app.put('/api/periods/:id/complete', (req, res) => {
  const db = readDb();
  const period = db.periods.find(p => p.id === req.params.id);
  if (!period) return res.status(404).json({ error: 'Not found' });
  period.status = 'completed';
  writeDb(db);
  broadcast('period_updated', period);
  res.json(period);
});

// ─── API: Readings ────────────────────────────────────────────────────────────

app.get('/api/periods/:id/readings', (req, res) => {
  const db = readDb();
  const readings = db.readings.filter(r => r.periodId === req.params.id);
  res.json(readings);
});

app.post('/api/readings', (req, res) => {
  const db = readDb();
  const { periodId, machineId, lifetimeIn, lifetimeOut, notes } = req.body;

  // Find OLD values: last completed reading or baseline
  const previous = db.readings
    .filter(r => r.machineId === machineId && r.periodId !== periodId)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))[0];

  const oldIn  = previous ? previous.lifetimeIn  : (db.baselineReadings[machineId]?.in  ?? 0);
  const oldOut = previous ? previous.lifetimeOut : (db.baselineReadings[machineId]?.out ?? 0);

  // Remove existing reading for this machine in this period (upsert)
  db.readings = db.readings.filter(r => !(r.periodId === periodId && r.machineId === machineId));

  const reading = {
    id: uuidv4(),
    periodId,
    machineId,
    lifetimeIn: Number(lifetimeIn),
    lifetimeOut: Number(lifetimeOut),
    oldIn,
    oldOut,
    weekIn:  Number(lifetimeIn)  - oldIn,
    weekOut: Number(lifetimeOut) - oldOut,
    weekSum: (Number(lifetimeIn) - oldIn) - (Number(lifetimeOut) - oldOut),
    notes: notes || '',
    savedAt: new Date().toISOString()
  };

  db.readings.push(reading);
  writeDb(db);
  broadcast('reading_saved', reading);
  res.json(reading);
});

app.delete('/api/readings/:id', (req, res) => {
  const db = readDb();
  db.readings = db.readings.filter(r => r.id !== req.params.id);
  writeDb(db);
  broadcast('reading_deleted', { id: req.params.id });
  res.json({ ok: true });
});

// ─── API: ATM Refills ─────────────────────────────────────────────────────────

app.get('/api/periods/:id/atm-refills', (req, res) => {
  const db = readDb();
  res.json(db.atmRefills.filter(r => r.periodId === req.params.id));
});

app.post('/api/atm-refills', (req, res) => {
  const db = readDb();
  const { periodId, locationId, amount, shortAmount, notes } = req.body;

  // Upsert: one ATM refill record per location per period
  db.atmRefills = db.atmRefills.filter(r => !(r.periodId === periodId && r.locationId === locationId));

  const refill = {
    id: uuidv4(),
    periodId,
    locationId,
    amount: Number(amount) || 0,
    shortAmount: Number(shortAmount) || 0,
    notes: notes || '',
    savedAt: new Date().toISOString()
  };
  db.atmRefills.push(refill);
  writeDb(db);
  broadcast('atm_refill_saved', refill);
  res.json(refill);
});

// ─── API: Tasks ───────────────────────────────────────────────────────────────

app.get('/api/tasks', (req, res) => {
  const db = readDb();
  const { periodId } = req.query;
  const tasks = periodId
    ? db.tasks.filter(t => t.periodId === periodId || !t.periodId)
    : db.tasks;
  res.json(tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/tasks', (req, res) => {
  const db = readDb();
  const task = {
    id: uuidv4(),
    periodId: req.body.periodId || null,
    locationId: req.body.locationId || null,
    locationName: req.body.locationName || '',
    text: req.body.text,
    completed: false,
    createdAt: new Date().toISOString()
  };
  db.tasks.push(task);
  writeDb(db);
  broadcast('task_added', task);
  res.json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const db = readDb();
  const task = db.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  Object.assign(task, req.body);
  writeDb(db);
  broadcast('task_updated', task);
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const db = readDb();
  db.tasks = db.tasks.filter(t => t.id !== req.params.id);
  writeDb(db);
  broadcast('task_deleted', { id: req.params.id });
  res.json({ ok: true });
});

// ─── API: Summary ─────────────────────────────────────────────────────────────

app.get('/api/summary/:periodId', (req, res) => {
  const db = readDb();
  const { periodId } = req.params;
  const readings  = db.readings.filter(r => r.periodId === periodId);
  const atmRefills = db.atmRefills.filter(r => r.periodId === periodId);

  const summary = db.customers.map(customer => {
    const customerLocations = db.locations.filter(l => l.customerId === customer.id);

    const locationSummaries = customerLocations.map(loc => {
      const locMachines  = db.machines.filter(m => m.locationId === loc.id);
      const locReadings  = readings.filter(r => locMachines.some(m => m.id === r.machineId));
      const locAtm       = atmRefills.find(a => a.locationId === loc.id);

      const grossProfit  = locReadings.reduce((sum, r) => sum + r.weekSum, 0);
      const customerShare = +(grossProfit * (loc.splitPercent / 100)).toFixed(2);
      const ourShare      = +(grossProfit * ((100 - loc.splitPercent) / 100)).toFixed(2);

      return {
        location: loc,
        machines: locMachines.map(m => {
          const r = locReadings.find(r => r.machineId === m.id);
          return { machine: m, reading: r || null };
        }),
        grossProfit,
        customerShare,
        ourShare,
        atmRefill: locAtm || null
      };
    });

    const totalGross    = locationSummaries.reduce((s, l) => s + l.grossProfit, 0);
    const totalCustomer = locationSummaries.reduce((s, l) => s + l.customerShare, 0);
    const totalOurs     = locationSummaries.reduce((s, l) => s + l.ourShare, 0);

    return { customer, locations: locationSummaries, totalGross, totalCustomer, totalOurs };
  });

  res.json(summary);
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`B&N Manager running on http://localhost:${PORT}`));
