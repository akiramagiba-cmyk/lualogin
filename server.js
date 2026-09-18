// ============================================================
// RUDO LICENSE SERVER
// Server + Telegram Bot + Database (all-in-one)
// v2.0 - All-features-unlocked approach
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

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN not set!');
  process.exit(1);
}

// ================== DATABASE ==================
const db = new Database(path.join(__dirname, 'rudo.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    key TEXT PRIMARY KEY,
    hwid TEXT,
    expire TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    login_count INTEGER DEFAULT 0
  );
`);

// ================== DB HELPERS ==================
function createLicense(key, expire) {
  try {
    db.prepare('INSERT INTO licenses (key, expire) VALUES (?, ?)').run(key, expire);
    return true;
  } catch (e) {
    return false;
  }
}

function getLicense(key) {
  return db.prepare('SELECT * FROM licenses WHERE key = ?').get(key) || null;
}

function validateLogin(key, hwid) {
  const lic = getLicense(key);
  if (!lic) return {valid: false, error: 'Invalid key'};
  if (!lic.active) return {valid: false, error: 'Key disabled'};

  const now = new Date();
  const expire = new Date(lic.expire + 'T23:59:59');
  if (now > expire) return {valid: false, error: 'Key expired'};

  if (!lic.hwid) {
    db.prepare('UPDATE licenses SET hwid = ? WHERE key = ?').run(hwid, key);
  } else if (lic.hwid !== hwid) {
    return {valid: false, error: 'HWID mismatch'};
  }

  db.prepare('UPDATE licenses SET login_count = login_count + 1 WHERE key = ?').run(key);
  return {valid: true};
}

function resetHWID(key) {
  return db.prepare('UPDATE licenses SET hwid = NULL WHERE key = ?').run(key).changes > 0;
}

function deleteLicense(key) {
  return db.prepare('DELETE FROM licenses WHERE key = ?').run(key).changes > 0;
}

function setActive(key, active) {
  return db.prepare('UPDATE licenses SET active = ? WHERE key = ?').run(active ? 1 : 0, key).changes > 0;
}

function extendLicense(key, days) {
  const lic = getLicense(key);
  if (!lic) return null;
  const d = new Date(lic.expire + 'T23:59:59');
  d.setDate(d.getDate() + days);
  const str = d.toISOString().split('T')[0];
  db.prepare('UPDATE licenses SET expire = ? WHERE key = ?').run(str, key);
  return str;
}

function listLicenses() {
  return db.prepare('SELECT * FROM licenses ORDER BY expire DESC').all();
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) c FROM licenses').get().c;
  const active = db.prepare('SELECT COUNT(*) c FROM licenses WHERE active = 1').get().c;
  const bound = db.prepare('SELECT COUNT(*) c FROM licenses WHERE hwid IS NOT NULL').get().c;
  return {total, active, bound};
}

// ================== KEY GENERATOR ==================
function generateKey(prefix = 'RUDO') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let rand = '';
  for (let i = 0; i < 8; i++) rand += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${rand}`;
}

// ================== EXPRESS SERVER ==================
const app = express();
app.use(express.json({limit: '10kb'}));

app.get('/', (req, res) => {
  res.json({name: 'RUDO License Server', status: 'running'});
});

app.post('/api/login', (req, res) => {
  const {key, hwid} = req.body || {};
  if (!key || !hwid) return res.status(400).json({valid: false, error: 'Missing key/hwid'});

  const result = validateLogin(key, hwid);
  if (!result.valid) return res.status(200).json({valid: false, error: result.error});
  
  // All features unlocked kapag valid ang login
  return res.status(200).json({valid: true, premium: true});
});

app.listen(PORT, () => console.log(`[SERVER] Port ${PORT}`));

// ================== TELEGRAM BOT ==================
const bot = new TelegramBot(BOT_TOKEN, {polling: true});

function isAdmin(msg) {
  return msg.from && ADMIN_IDS.includes(msg.from.id);
}

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `RUDO License Bot\n\n` +
    `Commands:\n` +
    `/login <key> - Check your license\n` +
    `/help - Show all commands\n\n` +
    `Channel: https://t.me/arcane_rudo\n` +
    `Owner: @Arcane_028`,
    {parse_mode: 'Markdown'});
});

// /help
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `Commands\n\n` +
    `User:\n` +
    `/login <key> - Validate key\n\n` +
    `Admin:\n` +
    `/gen <days> [count] [prefix]\n` +
    `/list\n` +
    `/reset <key>\n` +
    `/extend <key> <days>\n` +
    `/disable <key>\n` +
    `/enable <key>\n` +
    `/delete <key>\n` +
    `/stats`,
    {parse_mode: 'Markdown'});
});

// /login
bot.onText(/\/login(?:\s+(.+))?/, (msg, match) => {
  const key = match[1] ? match[1].trim() : null;
  if (!key) return bot.sendMessage(msg.chat.id, 'Usage: `/login RUDO-XXXXXXXX`', {parse_mode: 'Markdown'});

  const lic = getLicense(key);
  if (!lic) return bot.sendMessage(msg.chat.id, 'Invalid key.');

  const expire = new Date(lic.expire + 'T23:59:59');
  const daysLeft = Math.ceil((expire - new Date()) / 86400000);
  let status = !lic.active ? 'Disabled' : daysLeft < 0 ? 'Expired' : 'Active';

  bot.sendMessage(msg.chat.id,
    `License Info\n\n` +
    `Key: \`${lic.key}\`\n` +
    `Status: ${status}\n` +
    `Expires: ${lic.expire} (${daysLeft} days)\n` +
    `HWID: ${lic.hwid || 'not bound'}\n` +
    `Logins: ${lic.login_count}`,
    {parse_mode: 'Markdown'});
});

// /gen
bot.onText(/\/gen(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');

  const args = (match[1] || '').split(/\s+/);
  const days = parseInt(args[0]);
  const count = Math.min(parseInt(args[1]) || 1, 50);
  const prefix = args[2] || 'RUDO';

  if (!days || days < 1 || days > 3650) {
    return bot.sendMessage(msg.chat.id, 'Usage: `/gen <days> [count] [prefix]`', {parse_mode: 'Markdown'});
  }

  const d = new Date();
  d.setDate(d.getDate() + days);
  const expire = d.toISOString().split('T')[0];

  const keys = [];
  for (let i = 0; i < count; i++) {
    let key;
    do { key = generateKey(prefix); } while (getLicense(key));
    if (createLicense(key, expire)) keys.push(key);
  }

  bot.sendMessage(msg.chat.id,
    `Generated ${keys.length} key(s)\n` +
    `Expires: ${expire}\n\n` +
    keys.map(k => `\`${k}\``).join('\n'),
    {parse_mode: 'Markdown'});
});

// /list
bot.onText(/\/list/, (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const list = listLicenses();
  if (!list.length) return bot.sendMessage(msg.chat.id, 'No licenses yet.');

  const text = list.slice(0, 30).map(l => {
    const days = Math.ceil((new Date(l.expire + 'T23:59:59') - new Date()) / 86400000);
    const status = !l.active ? 'X' : days < 0 ? 'E' : 'O';
    return `[${status}] \`${l.key}\` (${days}d)`;
  }).join('\n');

  bot.sendMessage(msg.chat.id, `Licenses (${list.length}):\n\n${text}`, {parse_mode: 'Markdown'});
});

// /reset
bot.onText(/\/reset(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const key = (match[1] || '').trim();
  if (!key) return bot.sendMessage(msg.chat.id, 'Usage: `/reset <key>`', {parse_mode: 'Markdown'});
  bot.sendMessage(msg.chat.id, resetHWID(key) ? `HWID reset: \`${key}\`` : 'Key not found.', {parse_mode: 'Markdown'});
});

// /extend
bot.onText(/\/extend(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const args = (match[1] || '').split(/\s+/);
  const key = args[0], days = parseInt(args[1]);
  if (!key || !days) return bot.sendMessage(msg.chat.id, 'Usage: `/extend <key> <days>`', {parse_mode: 'Markdown'});
  const newDate = extendLicense(key, days);
  bot.sendMessage(msg.chat.id, newDate ? `Extended to ${newDate}` : 'Key not found.');
});

// /disable
bot.onText(/\/disable(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const key = (match[1] || '').trim();
  if (!key) return bot.sendMessage(msg.chat.id, 'Usage: `/disable <key>`', {parse_mode: 'Markdown'});
  bot.sendMessage(msg.chat.id, setActive(key, false) ? `Disabled: \`${key}\`` : 'Not found.', {parse_mode: 'Markdown'});
});

// /enable
bot.onText(/\/enable(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const key = (match[1] || '').trim();
  if (!key) return bot.sendMessage(msg.chat.id, 'Usage: `/enable <key>`', {parse_mode: 'Markdown'});
  bot.sendMessage(msg.chat.id, setActive(key, true) ? `Enabled: \`${key}\`` : 'Not found.', {parse_mode: 'Markdown'});
});

// /delete
bot.onText(/\/delete(?:\s+(.+))?/, (msg, match) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const key = (match[1] || '').trim();
  if (!key) return bot.sendMessage(msg.chat.id, 'Usage: `/delete <key>`', {parse_mode: 'Markdown'});
  bot.sendMessage(msg.chat.id, deleteLicense(key) ? `Deleted: \`${key}\`` : 'Not found.', {parse_mode: 'Markdown'});
});

// /stats
bot.onText(/\/stats/, (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, 'Admin only.');
  const s = getStats();
  bot.sendMessage(msg.chat.id,
    `Stats\n\nTotal: ${s.total}\nActive: ${s.active}\nBound: ${s.bound}`,
    {parse_mode: 'Markdown'});
});

console.log('[BOT] Started.');
