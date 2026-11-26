import 'dotenv/config';
import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3001);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyDataFile = path.join(root, 'server', 'data', 'projects.json');
const distDir = path.join(root, 'dist');
const generatedPassword = randomBytes(12).toString('base64url');
const adminPassword = process.env.DASHBOARD_PASSWORD || generatedPassword;
const sessions = new Map();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Add your Neon connection string to .env or your hosting environment.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', error => console.error('Unexpected idle database connection error:', error.message));

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const seed = [
  { id: 'motion-study-01', title: 'Smooth text animation', category: 'Motion graphics', type: 'Studio video', youtubeUrl: 'https://youtu.be/1aj4ILhsViA?si=brh7ZVEfo28fAcES', duration: '', summary: 'A step-by-step Alight Motion tutorial for creating smooth, expressive kinetic type.', featured: true, mark: '07' },
  { id: 'motion-study-02', title: 'Clear Food — Motion ad', category: 'Promotional video', type: 'Studio video', youtubeUrl: 'https://youtu.be/prod0SqGEXc?si=IGT_k8Lv1vj4tdT8', duration: '', summary: 'A motion design advertisement for Clear Food, built around a crisp and considered product story.', featured: false, mark: '08' },
];

const projectColumns = 'id, title, category, type, youtube_url, duration, summary, featured, mark';
const projectFields = `id, title, category, type, youtube_url AS "youtubeUrl", duration, summary, featured, mark`;

function safeString(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalize(input, previous = {}) {
  const title = safeString(input.title, 100);
  const youtubeUrl = safeString(input.youtubeUrl, 500);
  if (!title) throw new Error('A project title is required.');
  if (!youtubeUrl) throw new Error('Add a YouTube video link before publishing this project.');
  let parsed;
  try { parsed = new URL(youtubeUrl); } catch { throw new Error('Enter a valid YouTube URL.'); }
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(parsed.hostname)) {
    throw new Error('The video link must be from YouTube.');
  }
  return {
    id: previous.id || safeString(input.id, 100) || `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    title,
    category: safeString(input.category, 60) || 'Other',
    type: safeString(input.type, 60) || 'Spec project',
    youtubeUrl,
    duration: safeString(input.duration, 20),
    summary: safeString(input.summary, 500),
    featured: Boolean(input.featured),
    mark: previous.mark || String(Date.now()).slice(-2),
  };
}

async function readLegacyProjects() {
  try {
    const parsed = JSON.parse(await fs.readFile(legacyDataFile, 'utf8'));
    if (!Array.isArray(parsed)) return seed;
    const linkedProjects = parsed.filter(project => typeof project.youtubeUrl === 'string' && project.youtubeUrl.trim());
    return linkedProjects.length ? linkedProjects : seed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return seed;
  }
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Other',
      type TEXT NOT NULL DEFAULT 'Spec project',
      youtube_url TEXT NOT NULL CHECK (length(trim(youtube_url)) > 0),
      duration TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      featured BOOLEAN NOT NULL DEFAULT FALSE,
      mark TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS projects_one_featured_idx ON projects (featured) WHERE featured = TRUE');
  await pool.query('CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [580627]);
    const migration = await client.query('SELECT value FROM app_metadata WHERE key = $1', ['projects_json_migrated']);
    if (!migration.rowCount) {
      const existing = await client.query('SELECT COUNT(*)::int AS count FROM projects');
      if (existing.rows[0].count === 0) {
        const legacyProjects = await readLegacyProjects();
        for (const [index, item] of legacyProjects.entries()) {
          const project = normalize(item, { id: item.id, mark: item.mark });
          await client.query(
            `INSERT INTO projects (${projectColumns}, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO NOTHING`,
            [project.id, project.title, project.category, project.type, project.youtubeUrl, project.duration, project.summary, project.featured, project.mark, index],
          );
        }
      }
      await client.query('INSERT INTO app_metadata (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', ['projects_json_migrated', '1']);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function readProjects() {
  const result = await pool.query(`SELECT ${projectFields} FROM projects ORDER BY featured DESC, sort_order ASC, created_at ASC`);
  return result.rows;
}

async function withProjectTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [580627]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertProject(client, project, sortOrder) {
  const result = await client.query(
    `INSERT INTO projects (${projectColumns}, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${projectFields}`,
    [project.id, project.title, project.category, project.type, project.youtubeUrl, project.duration, project.summary, project.featured, project.mark, sortOrder],
  );
  return result.rows[0];
}

function adminOnly(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const expiry = sessions.get(token);
  if (!expiry || expiry < Date.now()) { sessions.delete(token); return res.status(401).json({ error: 'Your dashboard session expired. Sign in again.' }); }
  return next();
}

function matchesPassword(candidate = '') {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(adminPassword);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.get('/api/projects', async (_req, res, next) => {
  try { res.json({ projects: await readProjects() }); } catch (error) { next(error); }
});

app.post('/api/admin/login', (req, res) => {
  if (!matchesPassword(req.body?.password)) return res.status(401).json({ error: 'That password didn’t match. Check the backend terminal for the current dashboard password.' });
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
  return res.json({ token, expiresIn: 28800 });
});

app.post('/api/projects', adminOnly, async (req, res, next) => {
  try {
    const project = normalize(req.body);
    await withProjectTransaction(async client => {
      if (project.featured) await client.query('UPDATE projects SET featured = FALSE, updated_at = NOW() WHERE featured = TRUE');
      const order = await client.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM projects');
      await insertProject(client, project, project.featured ? -1 : order.rows[0].next_order);
    });
    return res.status(201).json({ project, projects: await readProjects() });
  } catch (error) { if (error.message) return res.status(400).json({ error: error.message }); next(error); }
});

app.put('/api/projects/:id', adminOnly, async (req, res, next) => {
  try {
    const updated = await withProjectTransaction(async client => {
      const current = await client.query(`SELECT ${projectFields}, sort_order FROM projects WHERE id = $1`, [req.params.id]);
      if (!current.rowCount) return null;
      const project = normalize(req.body, current.rows[0]);
      if (project.featured) await client.query('UPDATE projects SET featured = FALSE, updated_at = NOW() WHERE featured = TRUE AND id <> $1', [project.id]);
      const result = await client.query(
        `UPDATE projects SET title = $2, category = $3, type = $4, youtube_url = $5, duration = $6,
         summary = $7, featured = $8, mark = $9, updated_at = NOW()
         WHERE id = $1 RETURNING ${projectFields}`,
        [project.id, project.title, project.category, project.type, project.youtubeUrl, project.duration, project.summary, project.featured, project.mark],
      );
      return result.rows[0];
    });
    if (!updated) return res.status(404).json({ error: 'Project not found.' });
    return res.json({ project: updated, projects: await readProjects() });
  } catch (error) { if (error.message) return res.status(400).json({ error: error.message }); next(error); }
});

app.delete('/api/projects/:id', adminOnly, async (req, res, next) => {
  try {
    const deleted = await withProjectTransaction(async client => {
      const current = await client.query('SELECT featured FROM projects WHERE id = $1', [req.params.id]);
      if (!current.rowCount) return false;
      await client.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
      if (current.rows[0].featured) {
        await client.query('UPDATE projects SET featured = TRUE, updated_at = NOW() WHERE id = (SELECT id FROM projects ORDER BY sort_order ASC, created_at ASC LIMIT 1)');
      }
      return true;
    });
    if (!deleted) return res.status(404).json({ error: 'Project not found.' });
    return res.json({ projects: await readProjects() });
  } catch (error) { next(error); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use(express.static(distDir));
app.get('*', async (_req, res, next) => {
  try { await fs.access(path.join(distDir, 'index.html')); res.sendFile(path.join(distDir, 'index.html')); }
  catch { res.status(404).send('Build the frontend with npm run build, or open http://localhost:5173 while Vite is running.'); }
});
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'The server hit an unexpected error.' });
});

async function start() {
  await initializeDatabase();
  app.listen(port, '0.0.0.0', () => {
    console.log(`Stephanol API ready at http://localhost:${port}`);
    console.log('Neon database connected.');
    if (process.env.DASHBOARD_PASSWORD) console.log('Dashboard password loaded from DASHBOARD_PASSWORD.');
    else console.log(`Dashboard password for this run: ${generatedPassword}`);
  });
}

start().catch(async error => {
  console.error('Could not start the Stephanol API:', error.message);
  await pool.end();
  process.exitCode = 1;
});
