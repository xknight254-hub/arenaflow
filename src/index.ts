import express from 'express';
import { initializeDatabase } from './db.js';
import authRoutes from './routes/authRoutes.js';
import tournamentRoutes from './routes/tournamentRoutes.js';
import matchRoutes from './routes/matchRoutes.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'arenaflow', version: '1.0.0' });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/tournaments', tournamentRoutes);
app.use('/api', matchRoutes);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// Initialize database and start server
initializeDatabase();
app.listen(PORT, () => {
  console.log(`ArenaFlow server running on port ${PORT}`);
});

export default app;
