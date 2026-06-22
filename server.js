const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const IMAGES_DIR = path.join(__dirname, 'data', 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
app.use('/uploads', express.static(IMAGES_DIR));

// ─── DB: in-memory cache + MongoDB or file fallback ──────────────────────────

let _cache = null;
let _mongoCol = null;

const SEED_PATH = path.join(__dirname, 'data', 'init.json');
const LOCAL_PATH = path.join(__dirname, 'data', 'db.json');

async function initDb() {
  if (process.env.MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    _mongoCol = client.db('bnmanager').collection('state');
    const doc = await _mongoCol.findOne({ _id: 'main' });
    const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    if (doc) {
      // Always sync config from seed so changes to init.json take effect on redeploy
      doc.data.customers = seed.customers;
      doc.data.locations = seed.locations;
      doc.data.machines = seed.machines;
      doc.data.baselineReadings = seed.baselineReadings;
      _cache = doc.data;
    } else {
      _cache = seed;
    }
    await _mongoCol.replaceOne({ _id: 'main' }, { _id: 'main', data: _cache }, { upsert: true });
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

// ─── API: Photos ──────────────────────────────────────────────────────────────

app.get('/api/periods/:id/photos', (req, res) => {
  const db = readDb();
  if (!db.photos) db.photos = [];
  res.json(db.photos.filter(p => p.periodId === req.params.id));
});

app.post('/api/photos', (req, res) => {
  const db = readDb();
  if (!db.photos) db.photos = [];
  const { periodId, machineId, imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data' });

  const base64   = imageData.replace(/^data:image\/\w+;base64,/, '');
  const extMatch = imageData.match(/^data:image\/(\w+);/);
  const ext      = extMatch ? extMatch[1].replace('jpeg', 'jpg') : 'jpg';
  const filename = `${periodId.slice(0, 8)}-${machineId}-${Date.now()}.${ext}`;
  const filepath = path.join(IMAGES_DIR, filename);

  fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));

  // Remove previous photo for this machine+period (file + db record)
  const old = db.photos.find(p => p.periodId === periodId && p.machineId === machineId);
  if (old) {
    try { fs.unlinkSync(path.join(IMAGES_DIR, path.basename(old.imageUrl))); } catch {}
  }
  db.photos = db.photos.filter(p => !(p.periodId === periodId && p.machineId === machineId));

  const photo = { id: uuidv4(), periodId, machineId, imageUrl: `/uploads/${filename}`, savedAt: new Date().toISOString() };
  db.photos.push(photo);
  writeDb(db);
  broadcast('photo_saved', photo);
  res.json(photo);
});

app.delete('/api/photos/:id', (req, res) => {
  const db = readDb();
  if (!db.photos) db.photos = [];
  const photo = db.photos.find(p => p.id === req.params.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(path.join(IMAGES_DIR, path.basename(photo.imageUrl))); } catch {}
  db.photos = db.photos.filter(p => p.id !== req.params.id);
  writeDb(db);
  broadcast('photo_deleted', { id: req.params.id });
  res.json({ ok: true });
});

// ─── API: Previous readings (for OLD IN/OUT display) ─────────────────────────

app.get('/api/prev-readings', (req, res) => {
  const db = readDb();
  const activePeriodId = db.periods.find(p => p.status === 'active')?.id;
  const result = {};
  db.machines.forEach(m => {
    const prev = db.readings
      .filter(r => r.machineId === m.id && (!activePeriodId || r.periodId !== activePeriodId))
      .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))[0];
    if (prev) result[m.id] = { in: prev.lifetimeIn, out: prev.lifetimeOut };
  });
  res.json(result);
});

// ─── API: Analytics ───────────────────────────────────────────────────────────

app.get('/api/analytics/:periodId', (req, res) => {
  const db = readDb();
  const { periodId } = req.params;
  const allReadings    = db.readings;
  const periodReadings = allReadings.filter(r => r.periodId === periodId);

  // Per-machine stats
  const machineStats = db.machines.map(machine => {
    const allMachineReadings  = allReadings.filter(r => r.machineId === machine.id);
    const thisPeriodReading   = periodReadings.find(r => r.machineId === machine.id) || null;
    const location            = db.locations.find(l => l.id === machine.locationId);
    const totalPeriods        = allMachineReadings.length;
    const avgProfit           = totalPeriods > 0
      ? allMachineReadings.reduce((s, r) => s + r.weekSum, 0) / totalPeriods : 0;
    return {
      machine:     { id: machine.id, gameType: machine.gameType, locationId: machine.locationId },
      locationName: location?.name || machine.locationId,
      thisPeriodReading,
      totalPeriods,
      avgProfit:   Math.round(avgProfit * 100) / 100
    };
  });

  // Game-type stats across all periods
  const gameTypeMap = {};
  allReadings.forEach(r => {
    const machine = db.machines.find(m => m.id === r.machineId);
    if (!machine) return;
    const gt = machine.gameType;
    if (!gameTypeMap[gt]) gameTypeMap[gt] = { totalProfit: 0, totalIn: 0, count: 0 };
    gameTypeMap[gt].totalProfit += r.weekSum;
    gameTypeMap[gt].totalIn     += r.weekIn;
    gameTypeMap[gt].count++;
  });
  const gameTypeStats = Object.entries(gameTypeMap)
    .map(([type, d]) => ({
      gameType:    type,
      avgProfit:   Math.round(d.totalProfit / d.count),
      avgIn:       Math.round(d.totalIn     / d.count),
      totalPeriods: d.count
    }))
    .sort((a, b) => b.avgProfit - a.avgProfit);

  // Cash flow for this period
  const atmRefills      = db.atmRefills.filter(r => r.periodId === periodId);
  const totalIn         = periodReadings.reduce((s, r) => s + r.weekIn,  0);
  const totalOut        = periodReadings.reduce((s, r) => s + r.weekOut, 0);
  const totalProfit     = periodReadings.reduce((s, r) => s + r.weekSum, 0);
  const totalAtmRefills = atmRefills.reduce((s, r) => s + r.amount,      0);
  const totalAtmShort   = atmRefills.reduce((s, r) => s + r.shortAmount, 0);

  // Suggestions — machines below 50 % of period average
  const machinesWithData = machineStats.filter(m => m.thisPeriodReading);
  const avgThisPeriod    = machinesWithData.length > 0
    ? machinesWithData.reduce((s, m) => s + m.thisPeriodReading.weekSum, 0) / machinesWithData.length : 0;
  const bestGameType     = gameTypeStats[0];

  const suggestions = machineStats
    .filter(m => m.thisPeriodReading && avgThisPeriod > 0 && m.thisPeriodReading.weekSum < avgThisPeriod * 0.5)
    .map(m => ({
      machineId:     m.machine.id,
      locationName:  m.locationName,
      currentGame:   m.machine.gameType,
      currentProfit: m.thisPeriodReading.weekSum,
      suggestedGame: (bestGameType && bestGameType.gameType !== m.machine.gameType) ? bestGameType.gameType : null,
      bestAvgProfit: bestGameType ? bestGameType.avgProfit : 0
    }));

  res.json({
    machineStats,
    gameTypeStats,
    cashFlow: { totalIn, totalOut, totalProfit, totalAtmRefills, totalAtmShort, cashOnHand: totalIn - totalAtmRefills },
    atmDetails: atmRefills.map(r => {
      const loc = db.locations.find(l => l.id === r.locationId);
      return { locationName: loc?.name || r.locationId, amount: r.amount, shortAmount: r.shortAmount, notes: r.notes };
    }),
    suggestions,
    avgThisPeriod: Math.round(avgThisPeriod * 100) / 100
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
initDb().then(() => {
  server.listen(PORT, () => console.log(`B&N Manager running on http://localhost:${PORT}`));
}).catch(e => {
  console.error('Failed to init DB:', e.message);
  process.exit(1);
});
