const cron = require('node-cron');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../data');
const backupsDir = path.join(dataDir, 'backups');
const uploadsDir = path.join(__dirname, '../uploads');
const settingsFile = path.join(dataDir, 'backup-settings.json');

const CRON_EXPRESSIONS = {
  hourly:  '0 * * * *',
  daily:   '0 2 * * *',
  weekly:  '0 2 * * 0',
  monthly: '0 2 1 * *',
};

const VALID_INTERVALS = Object.keys(CRON_EXPRESSIONS);

let briefingTask = null;
let currentTask = null;

function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
  } catch (e) {}
  return { enabled: false, interval: 'daily', keep_days: 7 };
}

function saveSettings(settings) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

async function runBackup() {
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `auto-backup-${timestamp}.zip`;
  const outputPath = path.join(backupsDir, filename);

  try {
    // Flush WAL to main DB file before archiving
    try { const { db } = require('./db/database'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      const dbPath = path.join(dataDir, 'travel.db');
      if (fs.existsSync(dbPath)) archive.file(dbPath, { name: 'travel.db' });
      if (fs.existsSync(uploadsDir)) archive.directory(uploadsDir, 'uploads');
      archive.finalize();
    });
    console.log(`[Auto-Backup] Created: ${filename}`);
  } catch (err) {
    console.error('[Auto-Backup] Error:', err.message);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return;
  }

  const settings = loadSettings();
  if (settings.keep_days > 0) {
    cleanupOldBackups(settings.keep_days);
  }
}

function cleanupOldBackups(keepDays) {
  try {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(backupsDir).filter(f => f.endsWith('.zip'));
    for (const file of files) {
      const filePath = path.join(backupsDir, file);
      const stat = fs.statSync(filePath);
      if (stat.birthtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        console.log(`[Auto-Backup] Old backup deleted: ${file}`);
      }
    }
  } catch (err) {
    console.error('[Auto-Backup] Cleanup error:', err.message);
  }
}

function start() {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }

  const settings = loadSettings();
  if (!settings.enabled) {
    console.log('[Auto-Backup] Disabled');
    return;
  }

  const expression = CRON_EXPRESSIONS[settings.interval] || CRON_EXPRESSIONS.daily;
  currentTask = cron.schedule(expression, runBackup);
  console.log(`[Auto-Backup] Scheduled: ${settings.interval} (${expression}), retention: ${settings.keep_days === 0 ? 'forever' : settings.keep_days + ' days'}`);
}

// Demo mode: hourly reset of demo user data
let demoTask = null;

function startDemoReset() {
  if (demoTask) { demoTask.stop(); demoTask = null; }
  if (process.env.DEMO_MODE !== 'true') return;

  demoTask = cron.schedule('0 * * * *', () => {
    try {
      const { resetDemoUser } = require('./demo/demo-reset');
      resetDemoUser();
    } catch (err) {
      console.error('[Demo Reset] Error:', err.message);
    }
  });
  console.log('[Demo] Hourly reset scheduled (at :00 every hour)');
}

function stop() {
  if (currentTask) { currentTask.stop(); currentTask = null; }
  if (demoTask) { demoTask.stop(); demoTask = null; }
  if (briefingTask) { briefingTask.stop(); briefingTask = null; }
}

// Briefing job: runs hourly to send trip briefings 24h before departure
function startBriefingJob() {
  if (briefingTask) { briefingTask.stop(); briefingTask = null; }
  briefingTask = cron.schedule('0 * * * *', async () => {
    console.log('[Scheduler] Running briefing check...');
    try {
      await require('./jobs/briefing')();
    } catch (err) {
      console.error('[Scheduler] Briefing job error:', err);
    }
  });
  console.log('[Briefing] Hourly briefing job scheduled (at :00 every hour)');
}

module.exports = { start, stop, startBriefingJob, startDemoReset, loadSettings, saveSettings, VALID_INTERVALS };
