import { Router, Request, Response } from 'express';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { db } from '../db.js';
import { generateBracket, checkAndStartTournament, advanceBracket } from '../services/bracketService.js';
import type { AuthRequest, Tournament } from '../types.js';

const router = Router();

// POST /api/tournaments
router.post('/', authenticateToken, (req: Request & AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });

  const { name, description, format, max_players, best_of, rules, group_count, bracket_type, entry_fee, is_private, registration_deadline } = req.body;

  if (!name || !format || !max_players) {
    return res.status(400).json({ error: 'name, format, and max_players required' });
  }

  const validFormats = ['knockout', 'league', 'multi_bracket', 'swiss'];
  if (!validFormats.includes(format)) {
    return res.status(400).json({ error: `Invalid format. Must be one of: ${validFormats.join(', ')}` });
  }

  if (max_players < 2 || max_players > 128) {
    return res.status(400).json({ error: 'max_players must be between 2 and 128' });
  }

  try {
    const result = db.prepare(`
      INSERT INTO tournaments (name, description, format, max_players, best_of, rules, group_count, bracket_type, entry_fee, is_private, registration_deadline, owner_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registration_open')
    `).run(
      name, description || null, format, max_players, best_of || 1, rules || null,
      group_count || 0, bracket_type || 'single', entry_fee || 0, is_private ? 1 : 0,
      registration_deadline || null, req.user.id
    );

    const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(result.lastInsertRowid) as Tournament;

    // Auto-join creator as participant
    db.prepare('INSERT INTO participants (tournament_id, user_id, status, seed) VALUES (?, ?, ?, 1)')
      .run(tournament.id, req.user.id, 'registered');

    res.status(201).json({ tournament });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to create tournament', details: error.message });
  }
});

// GET /api/tournaments
router.get('/', (_req: Request, res: Response) => {
  const tournaments = db.prepare(`
    SELECT t.*, u.username as owner_username,
           (SELECT COUNT(*) FROM participants WHERE tournament_id = t.id) as participant_count
    FROM tournaments t
    JOIN users u ON t.owner_id = u.id
    WHERE t.is_private = 0
    ORDER BY t.created_at DESC
  `).all();
  res.json({ tournaments });
});

// GET /api/tournaments/:id
router.get('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid tournament ID' });

  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id) as Tournament | undefined;
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

  const participants = db.prepare(`
    SELECT p.*, u.username, u.avatar_url
    FROM participants p JOIN users u ON p.user_id = u.id
    WHERE p.tournament_id = ?
    ORDER BY p.seed ASC, p.joined_at ASC
  `).all(id);

  res.json({ tournament, participants });
});

// POST /api/tournaments/:id/join
router.post('/:id/join', authenticateToken, (req: Request & AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });

  const tournamentId = parseInt(req.params.id);
  if (isNaN(tournamentId)) return res.status(400).json({ error: 'Invalid tournament ID' });

  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId) as Tournament | undefined;
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
  if (tournament.status !== 'registration_open') return res.status(400).json({ error: 'Tournament is not open for registration' });

  // Check if already joined
  const existing = db.prepare('SELECT id FROM participants WHERE tournament_id = ? AND user_id = ?').get(tournamentId, req.user.id);
  if (existing) return res.status(409).json({ error: 'Already joined this tournament' });

  // Check capacity
  const count = (db.prepare('SELECT COUNT(*) as c FROM participants WHERE tournament_id = ?').get(tournamentId) as any).c;
  if (count >= tournament.max_players) return res.status(400).json({ error: 'Tournament is full' });

  const teamName = req.body.team_name || null;

  db.prepare('INSERT INTO participants (tournament_id, user_id, status, seed, team_name) VALUES (?, ?, ?, ?, ?)')
    .run(tournamentId, req.user.id, 'registered', count + 1, teamName);

  // Auto-start if full
  const started = checkAndStartTournament(tournamentId);

  res.status(201).json({
    success: true,
    message: started ? 'Joined! Tournament is now full and bracket has been generated.' : 'Joined tournament.',
    tournament_started: started,
  });
});

// POST /api/tournaments/:id/start — Admin manually starts tournament
router.post('/:id/start', authenticateToken, requireAdmin, (req: Request & AuthRequest, res: Response) => {
  const tournamentId = parseInt(req.params.id);
  if (isNaN(tournamentId)) return res.status(400).json({ error: 'Invalid tournament ID' });

  try {
    const matches = generateBracket(tournamentId);
    db.prepare("UPDATE tournaments SET status = 'in_progress' WHERE id = ?").run(tournamentId);
    res.json({ success: true, message: 'Tournament started', match_count: matches.length });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/tournaments/:id/matches
router.get('/:id/matches', (req: Request, res: Response) => {
  const tournamentId = parseInt(req.params.id);
  if (isNaN(tournamentId)) return res.status(400).json({ error: 'Invalid tournament ID' });

  const matches = db.prepare(`
    SELECT m.*,
           p1.username as player1_username, p2.username as player2_username,
           w.username as winner_username
    FROM matches m
    LEFT JOIN users p1 ON m.player1_id = p1.id
    LEFT JOIN users p2 ON m.player2_id = p2.id
    LEFT JOIN users w ON m.winner_id = w.id
    WHERE m.tournament_id = ?
    ORDER BY m.round ASC, m.match_number ASC
  `).all(tournamentId);

  res.json({ matches });
});

// GET /api/tournaments/:id/standings
router.get('/:id/standings', (req: Request, res: Response) => {
  const tournamentId = parseInt(req.params.id);
  if (isNaN(tournamentId)) return res.status(400).json({ error: 'Invalid tournament ID' });

  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

  // For league/swiss: compute standings from match results
  const standings = db.prepare(`
    SELECT
      u.id, u.username,
      COUNT(CASE WHEN m.winner_id = u.id THEN 1 END) as wins,
      COUNT(CASE WHEN m.status = 'completed' AND m.winner_id != u.id AND (m.player1_id = u.id OR m.player2_id = u.id) THEN 1 END) as losses,
      SUM(CASE WHEN m.player1_id = u.id THEN m.player1_score ELSE m.player2_score END) as goals_for,
      SUM(CASE WHEN m.player1_id = u.id THEN m.player2_score ELSE m.player1_score END) as goals_against
    FROM participants p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN matches m ON (m.player1_id = u.id OR m.player2_id = u.id) AND m.tournament_id = ? AND m.status = 'completed'
    WHERE p.tournament_id = ?
    GROUP BY u.id
    ORDER BY wins DESC, (SUM(CASE WHEN m.player1_id = u.id THEN m.player1_score ELSE m.player2_score END) - SUM(CASE WHEN m.player1_id = u.id THEN m.player2_score ELSE m.player1_score END)) DESC
  `).all(tournamentId, tournamentId);

  res.json({ standings });
});

// GET /api/tournaments/:id/analytics — Admin analytics dashboard
router.get('/:id/analytics', authenticateToken, (req: Request & AuthRequest, res: Response) => {
  const tournamentId = parseInt(req.params.id);
  if (isNaN(tournamentId)) return res.status(400).json({ error: 'Invalid tournament ID' });

  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId) as any;
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

  // Participant stats
  const participantCount = (db.prepare('SELECT COUNT(*) as c FROM participants WHERE tournament_id = ?').get(tournamentId) as any).c;

  // Match stats
  const totalMatches = (db.prepare('SELECT COUNT(*) as c FROM matches WHERE tournament_id = ?').get(tournamentId) as any).c;
  const completedMatches = (db.prepare('SELECT COUNT(*) as c FROM matches WHERE tournament_id = ? AND status = "completed"').get(tournamentId) as any).c;
  const pendingMatches = (db.prepare('SELECT COUNT(*) as c FROM matches WHERE tournament_id = ? AND status = "pending"').get(tournamentId) as any).c;
  const disputedMatches = (db.prepare('SELECT COUNT(*) as c FROM matches WHERE tournament_id = ? AND status = "disputed"').get(tournamentId) as any).c;

  // Verification stats
  const totalSubmissions = (db.prepare('SELECT COUNT(*) as c FROM result_submissions rs JOIN matches m ON rs.match_id = m.id WHERE m.tournament_id = ?').get(tournamentId) as any).c;
  const autoApproved = (db.prepare('SELECT COUNT(*) as c FROM result_submissions rs JOIN matches m ON rs.match_id = m.id WHERE m.tournament_id = ? AND rs.verification_status = "auto_approved"').get(tournamentId) as any).c;
  const fraudFlags = (db.prepare('SELECT COUNT(*) as c FROM fraud_logs fl JOIN matches m ON fl.match_id = m.id WHERE m.tournament_id = ?').get(tournamentId) as any).c;

  // Average confidence
  const avgConfidence = (db.prepare('SELECT AVG(rs.verification_confidence) as avg FROM result_submissions rs JOIN matches m ON rs.match_id = m.id WHERE m.tournament_id = ?').get(tournamentId) as any)?.avg || 0;

  // Goals stats
  const totalGoals = (db.prepare('SELECT SUM(player1_score + player2_score) as total FROM matches WHERE tournament_id = ? AND status = "completed"').get(tournamentId) as any)?.total || 0;

  // Top scorers
  const topScorers = db.prepare(`
    SELECT u.username,
           SUM(CASE WHEN m.player1_id = p.user_id THEN m.player1_score ELSE m.player2_score END) as goals
    FROM participants p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN matches m ON (m.player1_id = p.user_id OR m.player2_id = p.user_id) AND m.tournament_id = ? AND m.status = 'completed'
    WHERE p.tournament_id = ?
    GROUP BY p.user_id
    ORDER BY goals DESC
    LIMIT 5
  `).all(tournamentId, tournamentId);

  // Round progress
  const roundProgress = db.prepare(`
    SELECT round,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM matches
    WHERE tournament_id = ?
    GROUP BY round
    ORDER BY round ASC
  `).all(tournamentId);

  res.json({
    tournament: {
      id: tournament.id,
      name: tournament.name,
      format: tournament.format,
      status: tournament.status,
    },
    participants: {
      total: participantCount,
      max: tournament.max_players,
    },
    matches: {
      total: totalMatches,
      completed: completedMatches,
      pending: pendingMatches,
      disputed: disputedMatches,
      progress_pct: totalMatches > 0 ? Math.round((completedMatches / totalMatches) * 100) : 0,
    },
    verification: {
      total_submissions: totalSubmissions,
      auto_approved: autoApproved,
      fraud_flags: fraudFlags,
      avg_confidence: Math.round(avgConfidence * 10) / 10,
    },
    goals: {
      total: totalGoals,
      avg_per_match: completedMatches > 0 ? Math.round((totalGoals / completedMatches) * 10) / 10 : 0,
    },
    top_scorers: topScorers,
    round_progress: roundProgress,
  });
});

export default router;
