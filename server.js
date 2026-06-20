const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── DB: in-memory cache + MongoDB or file fallback ──────────────────────────

let _cache = null;
let _mongoCol = null;

const SEED_PATH = path.join(__dirname, 'data', 'db.json');
const LOCAL_PATH = path.join(__dirname, 'data', 'db.json');

async function initDb() {
  if (process.env.MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    _mongoCol = client.db('bnmanager').collection('state');
    const doc = await _mongoCol.findOne({ _id: 'main' });
    _cache = doc ? doc.data : JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    if (!doc) await _mongoCol.replaceOne({ _id: 'main' }, { _id: 'main', data: _cache }, { upsert: true });
    console.log('Connected to MongoDB');
  } else {
    _cache = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
    console.log('Using local JSON file');
  }
}

function readDb() {
  return _cache;
}

function writeDb(data) {
  _cache = data;
  if (_mongoCol) {
    _mongoCol.replaceOne({ _id: 'main' }, { _id: 'main', data }, { upsert: true })
      .catch(e => console.error('MongoDB write error:', e.message));
  } else {
    fs.writeFileSync(LOCAL_PATH, JSON.stringify(data, null, 2));
  }
}

// ─── WebSocket broadcast ──────────────────────────────────────────────────────

function broadcast(event, payload) {
  const msg = JSON.stringify({ event, payload });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', ws => { ws.on('error', () => {}); });

// ─── API: Config ──────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  const db = readDb();
  res.json({ customers: db.customers, locations: db.locations, machines: db.machines, baselineReadings: db.baselineReadings });
});

// ─── API: Periods ─────────────────────────────────────────────────────────────

app.get('/api/periods', (req, res) => res.json(readDb().periods));

app.post('/api/periods', (req, res) => {
  const db = readDb();
  db.periods.forEach(p => { if (p.status === 'active') p.status = 'completed'; });
  const period = {
    id: uuidv4(),
    label: req.body.label || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
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
  res.json(readDb().readings.filter(r => r.periodId === req.params.id));
});

app.post('/api/readings', (req, res) => {
  const db = readDb();
  const { periodId, machineId, lifetimeIn, lifetimeOut, notes } = req.body;

  const previous = db.readings
    .filter(r => r.machineId === machineId && r.periodId !== periodId)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))[0];

  const oldIn  = previous ? previous.lifetimeIn  : (db.baselineReadings[machineId]?.in  ?? 0);
  const oldOut = previous ? previous.lifetimeOut : (db.baselineReadings[machineId]?.out ?? 0);

  db.readings = db.readings.filter(r => !(r.periodId === periodId && r.machineId === machineId));

  const reading = {
    id: uuidv4(), periodId, machineId,
    lifetimeIn: Number(lifetimeIn), lifetimeOut: Number(lifetimeOut),
    oldIn, oldOut,
    weekIn:  Number(lifetimeIn)  - oldIn,
    weekOut: Number(lifetimeOut) - oldOut,
    weekSum: (Number(lifetimeIn) - oldIn) - (Number(lifetimeOut) - oldOut),
    notes: notes || '', savedAt: new Date().toISOString()
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
  res.json(readDb().atmRefills.filter(r => r.periodId === req.params.id));
});

app.post('/api/atm-refills', (req, res) => {
  const db = readDb();
  const { periodId, locationId, amount, shortAmount, notes } = req.body;
  db.atmRefills = db.atmRefills.filter(r => !(r.periodId === periodId && r.locationId === locationId));
  const refill = {
    id: uuidv4(), periodId, locationId,
    amount: Number(amount) || 0, shortAmount: Number(shortAmount) || 0,
    notes: notes || '', savedAt: new Date().toISOString()
  };
  db.atmRefills.push(refill);
  writeDb(db);
  broadcast('atm_refill_saved', refill);
  res.json(refill);
});

// ─── API: Tasks ───────────────────────────────────────────────────────────────

app.get('/api/tasks', (req, res) => {
  const { periodId } = req.query;
  const tasks = periodId
    ? readDb().tasks.filter(t => t.periodId === periodId || !t.periodId)
    : readDb().tasks;
  res.json(tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/tasks', (req, res) => {
  const db = readDb();
  const task = {
    id: uuidv4(),
    periodId: req.body.periodId || null,
    locationId: req.body.locationId || null,
    locationName: req.body.locationName || '',
    text: req.body.text, completed: false,
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
  const readings   = db.readings.filter(r => r.periodId === periodId);
  const atmRefills = db.atmRefills.filter(r => r.periodId === periodId);

  const summary = db.customers.map(customer => {
    const locs = db.locations.filter(l => l.customerId === customer.id);
    const locationSummaries = locs.map(loc => {
      const locMachines = db.machines.filter(m => m.locationId === loc.id);
      const locReadings = readings.filter(r => locMachines.some(m => m.id === r.machineId));
      const locAtm      = atmRefills.find(a => a.locationId === loc.id);
      const grossProfit = locReadings.reduce((s, r) => s + r.weekSum, 0);
      return {
        location: loc,
        machines: locMachines.map(m => ({ machine: m, reading: locReadings.find(r => r.machineId === m.id) || null })),
        grossProfit,
        customerShare: +(grossProfit * (loc.splitPercent / 100)).toFixed(2),
        ourShare:      +(grossProfit * ((100 - loc.splitPercent) / 100)).toFixed(2),
        atmRefill: locAtm || null
      };
    });
    return {
      customer, locations: locationSummaries,
      totalGross:    locationSummaries.reduce((s, l) => s + l.grossProfit, 0),
      totalCustomer: locationSummaries.reduce((s, l) => s + l.customerShare, 0),
      totalOurs:     locationSummaries.reduce((s, l) => s + l.ourShare, 0)
    };
  });

  res.json(summary);
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
initDb().then(() => {
  server.listen(PORT, () => console.log(`B&N Manager running on http://localhost:${PORT}`));
}).catch(e => {
  console.error('Failed to init DB:', e.message);
  process.exit(1);
});
