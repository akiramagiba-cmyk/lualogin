// ============================================================
// RUDO LICENSE SERVER v3.1
// Multi-Device Support (Fixed)
// ============================================================

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const path = require('path');

// ================== CONFIG ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
const PORT = process.env.PORT || 3000;
const DEFAULT_MAX_DEVICES = 50;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN not set!');
  process.exit(1);
}

// ================== DATABASE ==================
const db = new Database(path.join(__dirname, 'rudo.db'));
db.pragma('journal_mode = WAL');

// Create tables with proper error handling
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      key TEXT PRIMARY KEY,
      expire TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      login_count INTEGER DEFAULT 0,
      max_devices INTEGER DEFAULT 50
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_key TEXT NOT NULL,
      hwid TEXT NOT NULL,
      first_seen INTEGER DEFAULT (strftime('%s','now')),
      last_seen INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(license_key, hwid)
    );

    CREATE INDEX IF NOT EXISTS idx_devices_key ON devices(license_key);
  `);
  console.log('[DB] Tables ready');
} catch (e) {
  console.error('[DB] Error creating tables:', e.message);
}

// Migration: add max_devices column if missing
try {
  db.exec(`ALTER TABLE licenses ADD COLUMN max_devices INTEGER DEFAULT 50`);
  console.log('[DB] Added max_devices column');
} catch (e) {
  // Column already exists — ok lang
}

// ================== DB HELPERS ==================
function createLicense(key, expire, maxDevices = DEFAULT_MAX_DEVICES) {
  try {
    db.prepare('INSERT INTO licenses (key, expire, max_devices) VALUES (?, ?, ?)')
      .run(key, expire, maxDevices);
    return true;
  } catch (e) {
    console.error('[DB] createLicense error:', e.message);
    return false;
  }
}

function getLicense(key) {
  try {
    return db.prepare('SELECT * FROM licenses WHERE key = ?').get(key) || null;
  } catch (e) {
    console.error('[DB] getLicense error:', e.message);
    return null;
  }
}

function getDeviceCount(key) {
  try {
    const row = db.prepare('SELECT COUNT(*) c FROM devices WHERE license_key = ?').get(key);
    return row ? row.c : 0;
  } catch (e) {
    return 0;
  }
}

function registerDevice(key, hwid) {
  try {
    const existing = db.prepare('SELECT id FROM devices WHERE license_key = ? AND hwid = ?').get(key, hwid);
    
    if (existing) {
      db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), existing.id);
      return {ok: true, isNew: false};
    }
    
    const lic = getLicense(key);
    if (!lic) return {ok: false, error: 'License not found'};
    
    const maxDev = lic.max_devices || DEFAULT_MAX_DEVICES;
    const currentCount = getDeviceCount(key);
    
    if (currentCount >= maxDev) {
      return {ok: false, error: `Device limit reached (${currentCount}/${maxDev})`};
    }
    
    db.prepare('INSERT INTO devices (license_key, hwid) VALUES (?, ?)').run(key, hwid);
    return {ok: true, isNew: true};
  } catch (e) {
    console.error('[DB] registerDevice error:', e.message);
    return {ok: false, error: 'Database error'};
  }
}

function validateLogin(key, hwid) {
  const lic = getLicense(key);
  if (!lic) return {valid: false, error: 'Invalid key'};
  if (!lic.active) return {valid: false, error: 'Key disabled'};

  const now = new Date();
  const expire = new Date(lic.expire + 'T23:59:59');
  if (now > expire) return {valid: false, error: 'Key expired'};

  const deviceResult = registerDevice(key, hwid);
  if (!deviceResult.ok) {
    return {valid: false, error: deviceResult.error};
  }

  try {
    db.prepare('UPDATE licenses SET login_count = login_count + 1 WHERE key = ?').run(key);
  } catch (e) {}
  
  return {
    valid: true,
    deviceCount: getDeviceCount(key),
    maxDevices: lic.max_devices || DEFAULT_MAX_DEVICES
  };
}

function resetDevices(key) {
  try {
    const r = db.prepare('DELETE FROM devices WHERE license_key = ?').run(key);
    return r.changes;
  } catch (e) {
    return 0;
  }
}

function deleteLicense(key) {
  try {
    db.prepare('DELETE FROM devices WHERE license_key = ?').run(key);
    return db.prepare('DELETE FROM licenses WHERE key = ?').run(key).changes > 0;
  } catch (e) {
    return false;
  }
}

function setActive(key, active) {
  try {
    return db.prepare('UPDATE licenses SET active = ? WHERE key = ?').run(active ? 1 : 0, key).changes > 0;
  } catch (e) {
    return false;
  }
}

function extendLicense(key, days) {
  const lic = getLicense(key);
  if (!lic) return null;
  const d = new Date(lic.expire + 'T23:59:59');
  d.setDate(d.getDate() + days);
  const str = d.toISOString().split('T')[0];
  try {
    db.prepare('UPDATE licenses SET expire = ? WHERE key = ?').run(str, key);
    return str;
  } catch (e) {
    return null;
  }
}

function setMaxDevices(key, count) {
  try {
    return db.prepare('UPDATE licenses SET max_devices = ? WHERE key = ?').run(count, key).changes > 0;
  } catch (e) {
    return false;
  }
}

function listLicenses() {
  try {
    return db.prepare('SELECT * FROM licenses ORDER BY expire DESC').all();
  } catch (e) {
    return [];
  }
}

function getStats() {
  try {
    const total = db.prepare('SELECT COUNT(*) c FROM licenses').get().c;
    const active = db.prepare('SELECT COUNT(*) c FROM licenses WHERE active = 1').get().c;
    const devices = db.prepare('SELECT COUNT(*) c FROM devices').get().c;
    return {total, active, devices};
  } catch (e) {
    return {total: 0, active: 0, devices: 0};
  }
}

function generateKey(prefix = 'RUDO') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let rand = '';
  for (let i = 0; i < 8; i++) rand += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${rand}`;
}

// ================== EXPRESS ==================
const app = express();
app.use(express.json({limit: '10kb'}));

app.get('/', (req, res) => {
  res.json({name: 'RUDO License Server', status: 'running', version: '3.1'});
});

app.post('/api/login', (req, res) => {
  try {
    const {key, hwid} = req.body || {};
    if (!key || !hwid) {
      return res.status(400).json({valid: false, error: 'Missing key/hwid'});
    }

    const result = validateLogin(key, hwid);
    if (!result.valid) {
      return res.status(200).json({valid: false, error: result.error});
    }
    
    return res.status(200).json({
      valid: true,
      premium: true,
      deviceCount: result.deviceCount,
      maxDevices: result.maxDevices
    });
  } catch (e) {
    console.error('[API] Login error:', e.message);
    return res.status(500).json({valid: false, error: 'Server error'});
  }
});

app.listen(PORT, () => console.log(`[SERVER] Port ${PORT}`));

// ================== BOT ==================
const bot = new TelegramBot(BOT_TOKEN, {polling: true});

function isAdmin(msg) {
  return msg.from && ADMIN_IDS.includes(msg.from.id);
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `RUDO License Bot\n\n` +
    `Commands:\n` +
    `/login <key> - Check license\n` +
    `/help - All commands\n\n` +
    `Channel: https://t.me/arcane_rudo\n` +
    `Owner: @Arcane_028`,
    {parse_mode: 'Markdown'});
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `Commands\n\n` +
    `User:\n` +
    `/login <key>\n\n` +
    `Admin:\n` +
    `/gen <days> [count] [prefix] [maxdevices]\n` +
    `/list\n` +
    `/reset <key>\n` +
    `/extend <key> <days>\n` +
    `/disable <key>\n` +
    `/enable <key>\n` +
    `/delete <key>\n` +
    `/setdevices <key> <count>\n` +
    `/resetdevices <key>\n` +
    `/devices <key>\n` +
    `/stats`,
    {parse_mode: 'Markdown'});
});

bot.onText(/\/login(?:\s+(.+))?/, (msg, match) => {
  const key = match[1] ? match[1].trim() : null;
  if (!key) return bot.sendMessage(msg.chat.id, 'Usage: `/login RUDO-XXXXXXXX`', {parse_mode: 'Markdown'});

  const lic = getLicense(key);
  if (!lic) return bot.sendMessage(msg.chat.id, 'Invalid key.');

  const expire = new Date(lic.expire + 'T23:59:59');
  const daysLeft = Math.ceil((expire - new Date()) / 86400000);
  let status = !lic.active ? 'Disabled' : daysLeft < 0 ? 'Expired' : 'Active';
  const deviceCount = getDeviceCount(key);
  const maxDev = lic.max_devices || DEFAULT_MAX_DEVICES;

  bot.sendMessage(msg.chat.id,
    `License Info\n\n` +
    `Key: \`${lic.key}\`\n` +
    `Status: ${status}\n` +
    `Expires: ${lic.expire} (${daysLeft} days)\n` +
    `Devices: ${deviceCount}/${maxDev}\n` +
    `Logins: ${lic.login_count}`,
    {parse_mode: 'Markdown'});
});

bot.onText(/\/gen(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');

  const args = (match[1] || '').split(/\s+/);
  const days = parseInt(args[0]);
  const count = Math.min(parseInt(args[1]) || 1, 50);
  const prefix = args[2] || 'RUDO';
  const maxDevices = parseInt(args[3]) || DEFAULT_MAX_DEVICES;

  if (!days || days < 1 || days > 3650) {
    return bot.sendMessage(msg.chat.id,
      `Usage: \`/gen <days> [count] [prefix] [maxdevices]\`\n\n` +
      `Examples:\n` +
      `\`/gen 3 1 RUDO 50\` - 1 key, 3 days, 50 devices\n` +
      `\`/gen 7 5 FREE 10\` - 5 keys, 7 days, 10 devices`,
      {parse_mode: 'Markdown'});
  }

  const d = new Date();
  d.setDate(d.getDate() + days);
  const expire = d.toISOString().split('T')[0];

  const keys = [];
  for (let i = 0; i < count; i++) {
    let key;
    do { key = generateKey(prefix); } while (getLicense(key));
    if (createLicense(key, expire, maxDevices)) keys.push(key);
  }

  bot.sendMessage(msg.chat.id,
    `Generated ${keys.length} key(s)\n` +
    `Duration: ${days} days\n` +
    `Expires: ${expire}\n` +
    `Max devices: ${maxDevices}\n\n` +
    keys.map(k => `\`${k}\``).join('\n'),
    {parse_mode: 'Markdown'});
});

bot.onText(/\/list/, (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const list = listLicenses();
  if (!list.length) return bot.sendMessage(msg.chat.id, 'No licenses yet.');

  const text = list.slice(0, 20).map(l => {
    const days = Math.ceil((new Date(l.expire + 'T23:59:59') - new Date()) / 86400000);
    const status = !l.active ? 'X' : days < 0 ? 'E' : 'O';
    const devices = getDeviceCount(l.key);
    const maxDev = l.max_devices || DEFAULT_MAX_DEVICES;
    return `[${status}] \`${l.key}\` (${days}d, ${devices}/${maxDev})`;
  }).join('\n');

  bot.sendMessage(msg.chat.id, `Licenses (${list.length}):\n\n${text}`, {parse_mode: 'Markdown'});
});

bot.onText(/\/reset(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const key = (match[1] || '').trim();
  if (!key) return bot.sendMessage(msg.chat.id, 'Usage: `/reset <key>`', {parse_mode: 'Markdown'});
  
  const count = resetDevices(key);
  bot.sendMessage(msg.chat.id, count > 0 
    ? `Reset ${count} device(s) for \`${key}\`` 
    : `No devices found`, 
    {parse_mode: 'Markdown'});
});

bot.onText(/\/resetdevices(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const key = (match[1] || '').trim();
  if (!key) return bot.sendMessage(msg.chat.id, 'Usage: `/resetdevices <key>`', {parse_mode: 'Markdown'});
  
  const count = resetDevices(key);
  bot.sendMessage(msg.chat.id, count > 0 
    ? `Reset ${count} device(s) for \`${key}\`` 
    : `No devices found`, 
    {parse_mode: 'Markdown'});
});

bot.onText(/\/devices(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const key = (match[1] || '').trim();
  if (!key) return bot.sendMessage(msg.chat.id, 'Usage: `/devices <key>`', {parse_mode: 'Markdown'});
  
  try {
    const devices = db.prepare('SELECT * FROM devices WHERE license_key = ? ORDER BY last_seen DESC').all(key);
    if (!devices.length) return bot.sendMessage(msg.chat.id, 'No devices registered.');
    
    const text = devices.slice(0, 30).map((d, i) => {
      const lastSeen = new Date(d.last_seen * 1000).toISOString().split('T')[0];
      return `${i+1}. \`${d.hwid.substring(0, 25)}\` (${lastSeen})`;
    }).join('\n');
    
    bot.sendMessage(msg.chat.id, `Devices for \`${key}\` (${devices.length}):\n\n${text}`, {parse_mode: 'Markdown'});
  } catch (e) {
    bot.sendMessage(msg.chat.id, 'Database error.');
  }
});

bot.onText(/\/setdevices(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const args = (match[1] || '').split(/\s+/);
  const key = args[0], count = parseInt(args[1]);
  if (!key || !count) return bot.sendMessage(msg.chat.id, 'Usage: `/setdevices <key> <count>`', {parse_mode: 'Markdown'});
  
  if (setMaxDevices(key, count)) {
    bot.sendMessage(msg.chat.id, `Max devices for \`${key}\` set to ${count}`, {parse_mode: 'Markdown'});
  } else {
    bot.sendMessage(msg.chat.id, 'Key not found.');
  }
});

bot.onText(/\/extend(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const args = (match[1] || '').split(/\s+/);
  const key = args[0], days = parseInt(args[1]);
  if (!key || !days) return bot.sendMessage(msg.chat.id, 'Usage: `/extend <key> <days>`', {parse_mode: 'Markdown'});
  const newDate = extendLicense(key, days);
  bot.sendMessage(msg.chat.id, newDate ? `Extended to ${newDate}` : 'Key not found.');
});

bot.onText(/\/disable(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const key = (match[1] || '').trim();
  if (!key) return bot.sendMessage(msg.chat.id, 'Usage: `/disable <key>`', {parse_mode: 'Markdown'});
  bot.sendMessage(msg.chat.id, setActive(key, false) ? `Disabled: \`${key}\`` : 'Not found.', {parse_mode: 'Markdown'});
});

bot.onText(/\/enable(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const key = (match[1] || '').trim();
  if (!key) return bot.sendMessage(msg.chat.id, 'Usage: `/enable <key>`', {parse_mode: 'Markdown'});
  bot.sendMessage(msg.chat.id, setActive(key, true) ? `Enabled: \`${key}\`` : 'Not found.', {parse_mode: 'Markdown'});
});

bot.onText(/\/delete(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const key = (match[1] || '').trim();
  if (!key) return bot.sendMessage(msg.chat.id, 'Usage: `/delete <key>`', {parse_mode: 'Markdown'});
  bot.sendMessage(msg.chat.id, deleteLicense(key) ? `Deleted: \`${key}\`` : 'Not found.', {parse_mode: 'Markdown'});
});

bot.onText(/\/stats/, (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const s = getStats();
  bot.sendMessage(msg.chat.id,
    `Stats\n\nTotal: ${s.total}\nActive: ${s.active}\nDevices: ${s.devices}`,
    {parse_mode: 'Markdown'});
});

console.log('[BOT] Started.');
