/**
 * verificationService.ts — Full verification pipeline for ArenaFlow.
 * Handles team validation, fraud detection, confidence scoring, and persistence.
 */

import crypto from 'node:crypto';
import { parseEFOTBScreenshot, matchTeamName, ocrScreenshot } from './ocrService.js';
import { db } from '../db.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OCRTeams {
  left: string;
  right: string;
}

export interface TeamValidationResult {
  leftMatch: { ocrName: string; fixtureName: string; matched: boolean; confidence: number; method: string };
  rightMatch: { ocrName: string; fixtureName: string; matched: boolean; confidence: number; method: string };
  overallConfidence: number;
  swapped: boolean;
}

export interface FraudFlag {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  penalty: number;
}

export interface FraudCheckResult {
  flags: FraudFlag[];
  totalPenalty: number;
  isClean: boolean;
}

export interface VerificationSubmission {
  id: number;
  matchId: number;
  uploaderId: number;
  screenshotUrl: string;
  player1Score: number | null;
  player2Score: number | null;
  teamValidation: TeamValidationResult;
  fraudCheck: FraudCheckResult;
  confidence: number;
  status: 'auto_approved' | 'opponent_review' | 'rejected' | 'pending';
  createdAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m: number[][] = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++)
    for (let j = 1; j <= a.length; j++)
      m[i][j] = b[i - 1] === a[j - 1] ? m[i - 1][j - 1] : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
  return m[b.length][a.length];
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Team Validation ────────────────────────────────────────────────────────

export function validateTeams(ocrLeft: string, ocrRight: string, fixtureP1Team: string, fixtureP2Team: string): TeamValidationResult {
  const ocrL = normalizeName(ocrLeft);
  const ocrR = normalizeName(ocrRight);
  const fixP1 = normalizeName(fixtureP1Team);
  const fixP2 = normalizeName(fixtureP2Team);

  const leftP1 = similarity(ocrL, fixP1);
  const leftP2 = similarity(ocrL, fixP2);
  const rightP1 = similarity(ocrR, fixP1);
  const rightP2 = similarity(ocrR, fixP2);

  // Known team matching
  const knownOcrL = matchTeamName(ocrLeft);
  const knownOcrR = matchTeamName(ocrRight);
  const knownFixP1 = matchTeamName(fixtureP1Team);
  const knownFixP2 = matchTeamName(fixtureP2Team);

  let leftMatch = { ocrName: ocrLeft, fixtureName: fixtureP1Team, matched: false, confidence: 0, method: 'none' };
  let rightMatch = { ocrName: ocrRight, fixtureName: fixtureP2Team, matched: false, confidence: 0, method: 'none' };
  let swapped = false;

  // Try direct/fuzzy: L→P1, R→P2
  const directL = ocrL === fixP1;
  const directR = ocrR === fixP2;
  const knownL = knownOcrL && knownFixP1 && knownOcrL === knownFixP1;
  const knownR = knownOcrR && knownFixP2 && knownOcrR === knownFixP2;
  const fuzzyL = leftP1 >= 0.75 && leftP1 > leftP2;
  const fuzzyR = rightP2 >= 0.75 && rightP2 > rightP1;

  if (directL || knownL || fuzzyL) {
    leftMatch = { ocrName: ocrLeft, fixtureName: fixtureP1Team, matched: true, confidence: directL ? 100 : knownL ? 95 : Math.round(leftP1 * 100), method: directL ? 'direct' : knownL ? 'canonical' : 'fuzzy' };
  }
  if (directR || knownR || fuzzyR) {
    rightMatch = { ocrName: ocrRight, fixtureName: fixtureP2Team, matched: true, confidence: directR ? 100 : knownR ? 95 : Math.round(rightP2 * 100), method: directR ? 'direct' : knownR ? 'canonical' : 'fuzzy' };
  }

  // If that didn't work, try swapped: L→P2, R→P1
  if (!leftMatch.matched || !rightMatch.matched) {
    const directL2 = ocrL === fixP2;
    const directR2 = ocrR === fixP1;
    if (directL2 && directR2) {
      leftMatch = { ocrName: ocrLeft, fixtureName: fixtureP2Team, matched: true, confidence: 100, method: 'direct' };
      rightMatch = { ocrName: ocrRight, fixtureName: fixtureP1Team, matched: true, confidence: 100, method: 'direct' };
      swapped = true;
    }
  }

  const overallConfidence = leftMatch.matched && rightMatch.matched
    ? Math.round((leftMatch.confidence + rightMatch.confidence) / 2)
    : leftMatch.matched || rightMatch.matched
      ? Math.round(Math.max(leftMatch.confidence, rightMatch.confidence) * 0.5)
      : 0;

  return { leftMatch, rightMatch, overallConfidence, swapped };
}

// ─── Fraud Detection ────────────────────────────────────────────────────────

export function detectFraud(userId: number, matchId: number, screenshotHash: string, teamValidation: TeamValidationResult, ocrLeftScore: number | null, ocrRightScore: number | null): FraudCheckResult {
  const flags: FraudFlag[] = [];

  // Duplicate screenshot
  const dup = db.prepare('SELECT id, uploader_id FROM result_submissions WHERE screenshot_hash = ? AND created_at > datetime("now", "-7 days")').get(screenshotHash) as any;
  if (dup) {
    flags.push({
      type: dup.uploader_id === userId ? 'reused_screenshot' : 'duplicate_screenshot',
      severity: dup.uploader_id === userId ? 'high' : 'critical',
      message: dup.uploader_id === userId ? 'Same user reused a screenshot' : 'Identical screenshot submitted by different user',
      penalty: dup.uploader_id === userId ? 25 : 40,
    });
  }

  // Team mismatch
  if (!teamValidation.leftMatch.matched && !teamValidation.rightMatch.matched) {
    flags.push({ type: 'wrong_teams', severity: 'high', message: 'OCR teams do not match fixture', penalty: 25 });
  }

  // Impossible scores
  if (ocrLeftScore !== null && ocrRightScore !== null && (ocrLeftScore > 20 || ocrRightScore > 20)) {
    flags.push({ type: 'impossible_score', severity: 'medium', message: `Score ${ocrLeftScore}-${ocrRightScore} seems too high`, penalty: 15 });
  }

  // Suspicious frequency
  const recent = (db.prepare('SELECT COUNT(*) as c FROM result_submissions WHERE uploader_id = ? AND created_at > datetime("now", "-1 hour")').get(userId) as any).c;
  if (recent > 10) {
    flags.push({ type: 'suspicious_frequency', severity: 'medium', message: `${recent} submissions in last hour`, penalty: 15 });
  }

  // Log flags
  for (const flag of flags) {
    db.prepare('INSERT INTO fraud_logs (user_id, match_id, detection_type, severity, details) VALUES (?, ?, ?, ?, ?)')
      .run(userId, matchId, flag.type, flag.severity, flag.message);
  }

  const totalPenalty = flags.reduce((s, f) => s + f.penalty, 0);
  return { flags, totalPenalty, isClean: flags.length === 0 };
}

// ─── Confidence Scoring ─────────────────────────────────────────────────────

export function calculateConfidence(teamValidation: TeamValidationResult, ocrConfidence: number, fraudCheck: FraudCheckResult, hasScore: boolean): number {
  let score = 0;
  score += teamValidation.overallConfidence * 0.40;
  score += Math.min(ocrConfidence, 100) * 0.20;
  if (hasScore) score += 20;
  score -= fraudCheck.totalPenalty * 0.20;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────

export async function processVerification(matchId: number, uploaderId: number, screenshotUrl: string, screenshotBuffer: Buffer, ocrTeams: OCRTeams): Promise<VerificationSubmission> {
  const fixture = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as any;
  if (!fixture) throw new Error('Match not found');
  if (fixture.status === 'completed') throw new Error('Match already completed');
  if (fixture.player1_id !== uploaderId && fixture.player2_id !== uploaderId) throw new Error('Not a participant');

  const screenshotHash = crypto.createHash('sha256').update(screenshotBuffer).digest('hex');
  const parsed = parseEFOTBScreenshot('');  // OCR already done upstream
  const teamValidation = validateTeams(ocrTeams.left, ocrTeams.right, fixture.player1_team || '', fixture.player2_team || '');
  const hasScore = parsed.player1Score !== null && parsed.player2Score !== null;
  const fraudCheck = detectFraud(uploaderId, matchId, screenshotHash, teamValidation, parsed.player1Score, parsed.player2Score);
  const confidence = calculateConfidence(teamValidation, parsed.confidence, fraudCheck, hasScore);

  let status: VerificationSubmission['status'] = 'pending';
  if (confidence >= 90 && fraudCheck.isClean) status = 'auto_approved';
  else if (confidence >= 55) status = 'opponent_review';
  else status = 'rejected';

  const result = db.prepare(`
    INSERT INTO result_submissions
      (match_id, uploader_id, screenshot_url, screenshot_hash, ocr_team_left, ocr_team_right,
       ocr_score_left, ocr_score_right, ocr_raw_text, ocr_confidence, verification_confidence,
       team_match_result, fraud_score, fraud_flags, verification_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    matchId, uploaderId, screenshotUrl, screenshotHash, ocrTeams.left, ocrTeams.right,
    parsed.player1Score, parsed.player2Score, parsed.rawText, parsed.confidence, confidence,
    teamValidation.leftMatch.matched && teamValidation.rightMatch.matched ? 'both' : teamValidation.leftMatch.matched || teamValidation.rightMatch.matched ? 'one' : 'none',
    fraudCheck.totalPenalty, JSON.stringify(fraudCheck.flags.map(f => ({ type: f.type, severity: f.severity }))), status
  );

  // If auto-approved, update the match
  if (status === 'auto_approved' && parsed.player1Score !== null && parsed.player2Score !== null) {
    let winnerId = null;
    if (parsed.player1Score > parsed.player2Score) winnerId = fixture.player1_id;
    else if (parsed.player2Score > parsed.player1Score) winnerId = fixture.player2_id;

    db.prepare('UPDATE matches SET player1_score = ?, player2_score = ?, winner_id = ?, status = ?, verification_status = ?, submitted_by = ?, submitted_at = ? WHERE id = ?')
      .run(parsed.player1Score, parsed.player2Score, winnerId, winnerId ? 'completed' : 'pending', 'verified', uploaderId, new Date().toISOString(), matchId);

    if (winnerId) advanceBracket(fixture.tournament_id, matchId);
  }

  return {
    id: result.lastInsertRowid as number,
    matchId, uploaderId, screenshotUrl,
    player1Score: parsed.player1Score,
    player2Score: parsed.player2Score,
    teamValidation, fraudCheck, confidence, status,
    createdAt: new Date().toISOString(),
  };
}

export function handleOpponentResponse(matchId: number, userId: number, action: 'confirm' | 'dispute'): { success: boolean; message: string; match?: any } {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as any;
  if (!match) return { success: false, message: 'Match not found' };
  if (match.player1_id !== userId && match.player2_id !== userId) return { success: false, message: 'Not a participant' };
  if (match.status === 'completed') return { success: false, message: 'Match already completed' };

  if (action === 'confirm') {
    db.prepare('UPDATE matches SET status = ?, verification_status = ?, confirmed_at = ? WHERE id = ?')
      .run('completed', 'verified', new Date().toISOString(), matchId);
    return { success: true, message: 'Result confirmed', match: db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) };
  } else {
    db.prepare('UPDATE matches SET status = ?, verification_status = ? WHERE id = ?')
      .run('disputed', 'rejected', matchId);
    return { success: true, message: 'Result disputed. Admin review required.' };
  }
}

function advanceBracket(tournamentId: number, matchId: number): void {
  const match = db.prepare('SELECT * FROM matches WHERE id = ? AND tournament_id = ?').get(matchId, tournamentId) as any;
  if (!match || !match.winner_id) return;

  const nextMatch = db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND round = ? AND status = "pending" ORDER BY match_number ASC LIMIT 1')
    .get(tournamentId, match.round + 1) as any;
  if (!nextMatch) return;

  const slot = nextMatch.player1_id === null ? 'player1_id' : 'player2_id';
  db.prepare(`UPDATE matches SET ${slot} = ? WHERE id = ?`).run(match.winner_id, nextMatch.id);
}
