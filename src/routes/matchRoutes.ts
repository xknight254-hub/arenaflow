import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import { db } from '../db.js';
import { advanceBracket } from '../services/bracketService.js';
import { ocrScreenshot } from '../services/ocrService.js';
import { processVerification, handleOpponentResponse } from '../services/verificationService.js';
import type { AuthRequest } from '../types.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// POST /api/matches/:id/submit — Submit match result directly
router.post('/:id/submit', authenticateToken, (req: Request & AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });

  const matchId = parseInt(req.params.id);
  if (isNaN(matchId)) return res.status(400).json({ error: 'Invalid match ID' });

  const { player1_score, player2_score } = req.body;
  if (player1_score === undefined || player2_score === undefined) {
    return res.status(400).json({ error: 'player1_score and player2_score required' });
  }

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as any;
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.status === 'completed') return res.status(400).json({ error: 'Match already completed' });
  if (match.player1_id !== req.user.id && match.player2_id !== req.user.id) {
    return res.status(403).json({ error: 'You are not a participant in this match' });
  }

  let winnerId = null;
  if (player1_score > player2_score) winnerId = match.player1_id;
  else if (player2_score > player1_score) winnerId = match.player2_id;

  db.prepare(`UPDATE matches SET player1_score = ?, player2_score = ?, winner_id = ?, status = 'completed', submitted_by = ?, submitted_at = ? WHERE id = ?`)
    .run(player1_score, player2_score, winnerId, req.user.id, new Date().toISOString(), matchId);

  if (winnerId) advanceBracket(match.tournament_id, matchId);

  const updated = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  res.json({ success: true, match: updated });
});

// POST /api/matches/:id/confirm — Opponent confirms result
router.post('/:id/confirm', authenticateToken, (req: Request & AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const matchId = parseInt(req.params.id);
  if (isNaN(matchId)) return res.status(400).json({ error: 'Invalid match ID' });

  const result = handleOpponentResponse(matchId, req.user.id, 'confirm');
  if (!result.success) return res.status(400).json({ error: result.message });
  res.json({ success: true, message: result.message, match: result.match });
});

// POST /api/matches/:id/dispute — Opponent disputes result
router.post('/:id/dispute', authenticateToken, (req: Request & AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const matchId = parseInt(req.params.id);
  if (isNaN(matchId)) return res.status(400).json({ error: 'Invalid match ID' });

  const { reason } = req.body;
  const result = handleOpponentResponse(matchId, req.user.id, 'dispute');
  if (!result.success) return res.status(400).json({ error: result.message });

  if (reason) {
    db.prepare(`INSERT INTO fraud_logs (user_id, match_id, detection_type, severity, details) VALUES (?, ?, 'opponent_dispute', 'medium', ?)`)
      .run(req.user.id, matchId, `Dispute reason: ${reason.slice(0, 500)}`);
  }
  res.json({ success: true, message: result.message });
});

// PATCH /api/matches/:id/resolve — Admin resolves dispute
router.patch('/:id/resolve', authenticateToken, (req: Request & AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const matchId = parseInt(req.params.id);
  if (isNaN(matchId)) return res.status(400).json({ error: 'Invalid match ID' });

  const { winner_id, player1_score, player2_score } = req.body;
  if (!winner_id || player1_score === undefined || player2_score === undefined) {
    return res.status(400).json({ error: 'winner_id, player1_score, and player2_score required' });
  }

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as any;
  if (!match) return res.status(404).json({ error: 'Match not found' });

  db.prepare(`UPDATE matches SET winner_id = ?, player1_score = ?, player2_score = ?, status = 'completed', verification_status = 'verified', submitted_by = ?, submitted_at = ? WHERE id = ?`)
    .run(winner_id, player1_score, player2_score, req.user.id, new Date().toISOString(), matchId);

  advanceBracket(match.tournament_id, matchId);
  const updated = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  res.json({ success: true, message: 'Dispute resolved', match: updated });
});

// GET /api/matches/:id
router.get('/:id', (req: Request, res: Response) => {
  const matchId = parseInt(req.params.id);
  if (isNaN(matchId)) return res.status(400).json({ error: 'Invalid match ID' });

  const match = db.prepare(`
    SELECT m.*, p1.username as player1_username, p2.username as player2_username, w.username as winner_username
    FROM matches m
    LEFT JOIN users p1 ON m.player1_id = p1.id
    LEFT JOIN users p2 ON m.player2_id = p2.id
    LEFT JOIN users w ON m.winner_id = w.id
    WHERE m.id = ?
  `).get(matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  res.json({ match });
});

// POST /api/ocr/analyze — OCR-only (preview)
router.post('/ocr/analyze', authenticateToken, upload.single('screenshot'), async (req: Request & AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!req.file?.buffer) return res.status(400).json({ error: 'Screenshot required' });

  try {
    const result = await ocrScreenshot(req.file.buffer);
    res.json({ success: true, parsed: result });
  } catch (error: any) {
    res.status(500).json({ error: 'OCR failed', details: error.message });
  }
});

// POST /api/matches/:id/verify — Full verification pipeline
router.post('/:id/verify', authenticateToken, upload.single('screenshot'), async (req: Request & AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const matchId = parseInt(req.params.id);
  if (isNaN(matchId)) return res.status(400).json({ error: 'Invalid match ID' });
  if (!req.file?.buffer) return res.status(400).json({ error: 'Screenshot required' });

  try {
    const ocrResult = await ocrScreenshot(req.file.buffer);

    const ocrTeams = {
      left: ocrResult.player1Name || '',
      right: ocrResult.player2Name || '',
    };

    const verification = await processVerification(
      matchId,
      req.user.id,
      `/screenshots/${matchId}/${Date.now()}.png`,
      req.file.buffer,
      ocrTeams
    );

    res.json({
      success: true,
      verification: {
        id: verification.id,
        status: verification.status,
        confidence: verification.confidence,
        teamValidation: verification.teamValidation,
        fraudCheck: verification.fraudCheck,
        scores: verification.player1Score !== null ? {
          player1: verification.player1Score,
          player2: verification.player2Score,
        } : null,
      },
      ocr: {
        raw: ocrResult.rawText,
        parsed: {
          leftTeam: ocrResult.player1Name,
          rightTeam: ocrResult.player2Name,
          leftScore: ocrResult.player1Score,
          rightScore: ocrResult.player2Score,
          matchTime: ocrResult.matchTime,
        },
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Verification failed', details: error.message });
  }
});

// POST /api/matches/:id/auto-submit — OCR auto-submit shortcut
router.post('/:id/auto-submit', authenticateToken, upload.single('screenshot'), async (req: Request & AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const matchId = parseInt(req.params.id);
  if (isNaN(matchId)) return res.status(400).json({ error: 'Invalid match ID' });
  if (!req.file?.buffer) return res.status(400).json({ error: 'Screenshot required' });

  try {
    const ocrResult = await ocrScreenshot(req.file.buffer);

    if (ocrResult.player1Score !== null && ocrResult.player2Score !== null && ocrResult.confidence >= 90) {
      const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as any;
      if (!match) return res.status(404).json({ error: 'Match not found' });

      let winnerId = null;
      if (ocrResult.player1Score > ocrResult.player2Score) winnerId = match.player1_id;
      else if (ocrResult.player2Score > ocrResult.player1Score) winnerId = match.player2_id;

      db.prepare(`UPDATE matches SET player1_score = ?, player2_score = ?, winner_id = ?, status = 'completed', submitted_by = ?, submitted_at = ? WHERE id = ?`)
        .run(ocrResult.player1Score, ocrResult.player2Score, winnerId, req.user.id, new Date().toISOString(), matchId);

      if (winnerId) advanceBracket(match.tournament_id, matchId);

      return res.json({
        success: true,
        auto_approved: true,
        message: 'Result auto-approved and submitted',
        scores: { player1: ocrResult.player1Score, player2: ocrResult.player2Score },
      });
    }

    res.json({
      success: true,
      auto_approved: false,
      message: 'Confidence too low for auto-approval. Please submit manually.',
      ocr: { leftScore: ocrResult.player1Score, rightScore: ocrResult.player2Score, confidence: ocrResult.confidence },
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Auto-submit failed', details: error.message });
  }
});

export default router;
