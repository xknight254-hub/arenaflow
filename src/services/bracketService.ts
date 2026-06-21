/**
 * bracketService.ts — ArenaFlow bracket generation engine
 *
 * Supports four tournament formats:
 *   1. Knockout  (single elimination, seeded)
 *   2. League    (round-robin)
 *   3. Multi-bracket (group stage → knockout)
 *   4. Swiss     (score-based pairing, N-1 rounds)
 *
 * Pure tournament logic — no payment, Telegram, or wager awareness.
 */

import { db } from '../db.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Participant {
  id: number;
  user_id: number;
  username: string;
  seed: number | null;
}

export interface BracketMatch {
  round: number;
  matchNumber: number;
  player1Id: number | null;
  player2Id: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateSeedingPositions(n: number): number[] {
  if (n === 2) return [1, 2];
  let positions = [1, 2];
  while (positions.length < n) {
    const next: number[] = [];
    const total = positions.length * 2;
    for (const p of positions) {
      next.push(p);
      next.push(total + 1 - p);
    }
    positions = next;
  }
  return positions;
}

// ─── Format generators ───────────────────────────────────────────────────────

function generateKnockoutBracket(participants: Participant[], tournamentId: number): BracketMatch[] {
  const matches: BracketMatch[] = [];
  const n = participants.length;
  const rounds = Math.ceil(Math.log2(n));
  let matchCounter = 1;
  const positions = generateSeedingPositions(n);

  for (let i = 0; i < n; i += 2) {
    const p1Idx = positions[i] - 1;
    const p2Idx = positions[i + 1] - 1;
    matches.push({
      round: 1,
      matchNumber: matchCounter++,
      player1Id: participants[p1Idx]?.user_id ?? null,
      player2Id: participants[p2Idx]?.user_id ?? null,
    });
  }

  let matchesInRound = Math.floor(n / 2);
  for (let r = 2; r <= rounds; r++) {
    matchesInRound = Math.ceil(matchesInRound / 2);
    for (let m = 0; m < matchesInRound; m++) {
      matches.push({ round: r, matchNumber: matchCounter++, player1Id: null, player2Id: null });
    }
  }
  return matches;
}

function generateLeagueBracket(participants: Participant[], tournamentId: number): BracketMatch[] {
  const matches: BracketMatch[] = [];
  let matchCounter = 1;
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      matches.push({
        round: 1,
        matchNumber: matchCounter++,
        player1Id: participants[i].user_id,
        player2Id: participants[j].user_id,
      });
    }
  }
  return matches;
}

function generateMultiBracket(participants: Participant[], tournamentId: number, groupCount: number): BracketMatch[] {
  const matches: BracketMatch[] = [];
  let matchCounter = 1;
  const n = participants.length;
  const playersPerGroup = Math.ceil(n / groupCount);

  const groups: Participant[][] = [];
  for (let g = 0; g < groupCount; g++) {
    groups.push(participants.slice(g * playersPerGroup, Math.min((g + 1) * playersPerGroup, n)));
  }

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        matches.push({
          round: g + 1,
          matchNumber: matchCounter++,
          player1Id: group[i].user_id,
          player2Id: group[j].user_id,
        });
      }
    }
  }

  const koPlayers = Math.min(groupCount * 2, n);
  const koRounds = Math.ceil(Math.log2(koPlayers));
  const koGroupRound = groupCount + 1;

  for (let i = 0; i < koPlayers; i += 2) {
    matches.push({ round: koGroupRound, matchNumber: matchCounter++, player1Id: null, player2Id: null });
  }
  let koMatchesInRound = Math.floor(koPlayers / 2);
  for (let r = 1; r < koRounds; r++) {
    koMatchesInRound = Math.ceil(koMatchesInRound / 2);
    for (let m = 0; m < koMatchesInRound; m++) {
      matches.push({ round: koGroupRound + r, matchNumber: matchCounter++, player1Id: null, player2Id: null });
    }
  }

  return matches;
}

function generateSwissBracket(participants: Participant[], tournamentId: number): BracketMatch[] {
  const matches: BracketMatch[] = [];
  let matchCounter = 1;
  const n = participants.length;
  const rounds = n % 2 === 0 ? n - 1 : n;
  const half = Math.floor(n / 2);

  const shuffled = shuffle(participants);
  for (let i = 0; i < half; i++) {
    matches.push({
      round: 1,
      matchNumber: matchCounter++,
      player1Id: shuffled[i]?.user_id ?? null,
      player2Id: shuffled[i + half]?.user_id ?? null,
    });
  }

  for (let r = 2; r <= Math.min(rounds, 5); r++) {
    for (let m = 0; m < half; m++) {
      matches.push({ round: r, matchNumber: matchCounter++, player1Id: null, player2Id: null });
    }
  }
  return matches;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function generateBracket(tournamentId: number): BracketMatch[] {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId) as any;
  if (!tournament) throw new Error(`Tournament ${tournamentId} not found.`);

  const participants = db.prepare(`
    SELECT p.id, p.user_id, p.seed, u.username
    FROM participants p
    JOIN users u ON p.user_id = u.id
    WHERE p.tournament_id = ?
    ORDER BY p.seed ASC
  `).all(tournamentId) as Participant[];

  if (participants.length < 2) throw new Error('At least 2 participants required.');

  db.prepare('DELETE FROM matches WHERE tournament_id = ?').run(tournamentId);

  let matchData: BracketMatch[];
  switch (tournament.format) {
    case 'knockout':
      matchData = generateKnockoutBracket(participants, tournamentId);
      break;
    case 'league':
      matchData = generateLeagueBracket(participants, tournamentId);
      break;
    case 'multi_bracket':
      matchData = generateMultiBracket(participants, tournamentId, tournament.group_count || 2);
      break;
    case 'swiss':
      matchData = generateSwissBracket(participants, tournamentId);
      break;
    default:
      throw new Error(`Unknown format: ${tournament.format}`);
  }

  const insert = db.prepare(`
    INSERT INTO matches (tournament_id, round, match_number, player1_id, player2_id, player1_team, player2_team, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);

  const teamMap = new Map(
    db.prepare('SELECT user_id, team_name FROM participants WHERE tournament_id = ?').all(tournamentId)
      .map((r: any) => [r.user_id, r.team_name])
  );

  for (const m of matchData) {
    insert.run(
      tournamentId, m.round, m.matchNumber, m.player1Id, m.player2Id,
      m.player1Id ? teamMap.get(m.player1Id) || null : null,
      m.player2Id ? teamMap.get(m.player2Id) || null : null
    );
  }

  return matchData;
}

export function checkAndStartTournament(tournamentId: number): boolean {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId) as any;
  if (!tournament) return false;
  if (tournament.status !== 'registration_open' && tournament.status !== 'open') return false;

  const count = (db.prepare('SELECT COUNT(*) as c FROM participants WHERE tournament_id = ?').get(tournamentId) as any).c;
  if (count < tournament.max_players) return false;

  generateBracket(tournamentId);
  db.prepare("UPDATE tournaments SET status = 'in_progress' WHERE id = ?").run(tournamentId);
  return true;
}

export function advanceBracket(tournamentId: number, matchId: number): void {
  const match = db.prepare('SELECT * FROM matches WHERE id = ? AND tournament_id = ?').get(matchId, tournamentId) as any;
  if (!match || !match.winner_id) return;

  // Find next round match
  const nextMatch = db.prepare(`
    SELECT * FROM matches
    WHERE tournament_id = ? AND round = ? AND status = 'pending'
    ORDER BY match_number ASC
    LIMIT 1
  `).get(tournamentId, match.round + 1) as any;

  if (!nextMatch) return;

  // Determine which slot to fill
  const slot = nextMatch.player1_id === null ? 'player1_id' : 'player2_id';
  db.prepare(`UPDATE matches SET ${slot} = ? WHERE id = ?`).run(match.winner_id, nextMatch.id);
}
