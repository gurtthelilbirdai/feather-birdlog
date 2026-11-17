// Feather Birdlog API: shared bird sighting log with a flock life list.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
const DB_PATH = path.join(DIR, 'birdlog.db');
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS sightings (
  id TEXT PRIMARY KEY,
  bird TEXT NOT NULL,
  species TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  place TEXT DEFAULT '',
  seen TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sighting_id TEXT NOT NULL,
  bird TEXT DEFAULT 'gurt',
  kind TEXT NOT NULL,
  note TEXT DEFAULT '',
  at TEXT NOT NULL
)`);

const stmt = {
  all: db.prepare('SELECT * FROM sightings ORDER BY created DESC'),
  get: db.prepare('SELECT * FROM sightings WHERE id = ?'),
  insert: db.prepare('INSERT INTO sightings (id,bird,species,count,place,seen,note,created) VALUES (@id,@bird,@species,@count,@place,@seen,@note,@created)'),
  remove: db.prepare('DELETE FROM sightings WHERE id = ?'),
  event: db.prepare('INSERT INTO events (sighting_id,bird,kind,note,at) VALUES (?,?,?,?,?)'),
  eventsFor: db.prepare('SELECT * FROM events WHERE sighting_id = ? ORDER BY id ASC')
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 100000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); } });
  });
}

function nightOf(iso) { return String(iso).slice(0, 10); }

module.exports = async function handler(req, res, seg) {
  const route = seg[0] || '';

  if (req.method === 'GET' && route === 'sightings') {
    const rows = stmt.all.all();
    const life = {};
    rows.forEach((r) => {
      const s = String(r.species || '').trim().toLowerCase();
      if (!s) return;
      life[s] = life[s] || { species: r.species, total: 0, sightings: 0, best: 0, last: '' };
      life[s].total += Number(r.count || 0);
      life[s].sightings += 1;
      life[s].best = Math.max(life[s].best, Number(r.count || 0));
      if (String(r.created) > String(life[s].last)) life[s].last = r.created;
    });
    const birds = new Set(rows.map((r) => r.bird));
    return json(res, 200, {
      sightings: rows,
      life: Object.values(life).sort((a, b) => b.total - a.total),
      stats: { total: rows.length, birds: birds.size, species: Object.keys(life).length, individuals: rows.reduce((n, r) => n + Number(r.count || 0), 0) }
    });
  }

  if (req.method === 'GET' && route === 'sighting' && seg[1]) {
    const row = stmt.get.get(seg[1]);
    if (!row) return json(res, 404, { error: 'no such sighting' });
    return json(res, 200, { sighting: row, events: stmt.eventsFor.all(seg[1]) });
  }

  if (req.method === 'POST' && route === 'sighting' && seg[1] === 'new') {
    const body = await readBody(req);
    const species = String(body.species || '').trim().slice(0, 60);
    if (!species) return json(res, 400, { error: 'which bird did you see?' });
    const now = new Date().toISOString();
    const s = {
      id: 'FB' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(),
      bird: String(body.bird || 'gurt').trim().slice(0, 40) || 'gurt',
      species,
      count: Math.max(1, Math.min(9999, parseInt(body.count, 10) || 1)),
      place: String(body.place || '').trim().slice(0, 80),
      seen: String(body.seen || now).slice(0, 40),
      note: String(body.note || '').slice(0, 1000),
      created: now
    };
    stmt.insert.run(s);
    stmt.event.run(s.id, s.bird, 'logged', s.species + (s.place ? ' at ' + s.place : ''), now);
    return json(res, 200, { ok: true, sighting: s });
  }

  if (req.method === 'POST' && route === 'sighting' && seg[1] && seg[2] === 'delete') {
    await readBody(req);
    const row = stmt.get.get(seg[1]);
    if (!row) return json(res, 404, { error: 'no such sighting' });
    stmt.remove.run(seg[1]);
    return json(res, 200, { ok: true, removed: seg[1] });
  }

  if (req.method === 'POST' && route === 'sighting' && seg[1] && seg[2] === 'note') {
    const body = await readBody(req);
    const row = stmt.get.get(seg[1]);
    if (!row) return json(res, 404, { error: 'no such sighting' });
    const note = String(body.note || '').trim().slice(0, 500);
    if (!note) return json(res, 400, { error: 'note required' });
    const now = new Date().toISOString();
    stmt.event.run(seg[1], String(body.bird || row.bird || 'gurt').slice(0, 40), 'note', note, now);
    return json(res, 200, { ok: true, events: stmt.eventsFor.all(seg[1]) });
  }

  return false;
};
