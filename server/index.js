import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const app = express();
const port = Number(process.env.PORT || 3001);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = path.join(root, 'server', 'data', 'projects.json');
const distDir = path.join(root, 'dist');
const generatedPassword = randomBytes(12).toString('base64url');
const adminPassword = process.env.DASHBOARD_PASSWORD || generatedPassword;
const sessions = new Map();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const seed = [
  { id: 'motion-study-01', title: 'Smooth text animation', category: 'Motion graphics', type: 'Studio video', youtubeUrl: 'https://youtu.be/1aj4ILhsViA?si=brh7ZVEfo28fAcES', duration: '', summary: 'A step-by-step Alight Motion tutorial for creating smooth, expressive kinetic type.', featured: true, mark: '07' },
  { id: 'motion-study-02', title: 'Clear Food — Motion ad', category: 'Promotional video', type: 'Studio video', youtubeUrl: 'https://youtu.be/prod0SqGEXc?si=IGT_k8Lv1vj4tdT8', duration: '', summary: 'A motion design advertisement for Clear Food, built around a crisp and considered product story.', featured: false, mark: '08' },
];

async function readProjects() {
  try {
    const parsed = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    if (!Array.isArray(parsed)) return seed;
    const linkedProjects = parsed.filter(project => typeof project.youtubeUrl === 'string' && project.youtubeUrl.trim());
    if (linkedProjects.length !== parsed.length) await writeProjects(linkedProjects);
    return linkedProjects;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(path.dirname(dataFile), { recursive: true });
    await fs.writeFile(dataFile, JSON.stringify(seed, null, 2));
    return seed;
  }
}
async function writeProjects(projects) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  const temp = `${dataFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(projects, null, 2));
  await fs.rename(temp, dataFile);
}
function safeString(value, max = 500) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function normalize(input, previous = {}) {
  const title = safeString(input.title, 100);
  const youtubeUrl = safeString(input.youtubeUrl, 500);
  if (!title) throw new Error('A project title is required.');
  if (!youtubeUrl) throw new Error('Add a YouTube video link before publishing this project.');
  if (youtubeUrl) {
    let parsed;
    try { parsed = new URL(youtubeUrl); } catch { throw new Error('Enter a valid YouTube URL.'); }
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(parsed.hostname)) throw new Error('The video link must be from YouTube.');
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

app.get('/api/health', (_req, res) => res.json({ ok: true }));
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
    const projects = await readProjects();
    const project = normalize(req.body);
    const nextProjects = project.featured ? [project, ...projects.map(p => ({ ...p, featured: false }))] : [...projects, project];
    await writeProjects(nextProjects);
    return res.status(201).json({ project, projects: nextProjects });
  } catch (error) { if (error.message) return res.status(400).json({ error: error.message }); next(error); }
});
app.put('/api/projects/:id', adminOnly, async (req, res, next) => {
  try {
    const projects = await readProjects();
    const index = projects.findIndex(p => p.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'Project not found.' });
    const project = normalize(req.body, projects[index]);
    let nextProjects = projects.map((p, i) => i === index ? project : p);
    if (project.featured) nextProjects = [project, ...nextProjects.filter(p => p.id !== project.id).map(p => ({ ...p, featured: false }))];
    await writeProjects(nextProjects);
    return res.json({ project, projects: nextProjects });
  } catch (error) { if (error.message) return res.status(400).json({ error: error.message }); next(error); }
});
app.delete('/api/projects/:id', adminOnly, async (req, res, next) => {
  try {
    const projects = await readProjects();
    const nextProjects = projects.filter(p => p.id !== req.params.id);
    if (nextProjects.length === projects.length) return res.status(404).json({ error: 'Project not found.' });
    if (projects.find(p => p.id === req.params.id)?.featured && nextProjects.length) nextProjects[0].featured = true;
    await writeProjects(nextProjects);
    return res.json({ projects: nextProjects });
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

app.listen(port, '0.0.0.0', () => {
  console.log(`Stephanol API ready at http://localhost:${port}`);
  if (process.env.DASHBOARD_PASSWORD) console.log('Dashboard password loaded from DASHBOARD_PASSWORD.');
  else console.log(`Dashboard password for this run: ${generatedPassword}`);
});
