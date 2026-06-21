/**
 * ocrService.ts — OCR processing engine for eFootball match result screenshots.
 *
 * Uses tesseract.js with a singleton worker pool (worker init is expensive, ~2s).
 * Parses OCR text into structured EFOTBOCRResult with multi-strategy extraction.
 */

import { createWorker } from 'tesseract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MatchOrientation = 'FULL_TIME' | 'HALF_TIME' | 'LIVE' | 'UNKNOWN';

export interface StatTuple {
  player1: number;
  player2: number;
}

export interface EFOTBOCRResult {
  player1Name: string;
  player2Name: string;
  player1Score: number | null;
  player2Score: number | null;
  matchTime: string | null;
  competition: string | null;
  stats: {
    possession: StatTuple | null;
    shots: StatTuple | null;
    fouls: StatTuple | null;
  };
  confidence: number;          // 0-100
  rawText: string;
  orientation: MatchOrientation;
}

// ---------------------------------------------------------------------------
// Known teams database (~40 clubs + national teams with aliases)
// ---------------------------------------------------------------------------

interface TeamEntry {
  canonical: string;
  aliases: string[];
}

const KNOWN_TEAMS: TeamEntry[] = [
  // --- Premier League ---
  { canonical: 'Arsenal', aliases: ['arsenal', 'ars', 'gunners'] },
  { canonical: 'Chelsea', aliases: ['chelsea', 'che', 'blues'] },
  { canonical: 'Liverpool', aliases: ['liverpool', 'liv', 'reds'] },
  { canonical: 'Manchester City', aliases: ['manchester city', 'man city', 'mci', 'city'] },
  { canonical: 'Manchester United', aliases: ['manchester united', 'man united', 'man utd', 'mnu', 'united'] },
  { canonical: 'Tottenham', aliases: ['tottenham', 'tottenham hotspur', 'tot', 'spurs'] },
  { canonical: 'Newcastle United', aliases: ['newcastle', 'newcastle united', 'new', 'toon'] },
  { canonical: 'Aston Villa', aliases: ['aston villa', 'ava', 'villa'] },
  { canonical: 'Brighton', aliases: ['brighton', 'brighton & hove albion', 'bha'] },
  { canonical: 'West Ham', aliases: ['west ham', 'west ham united', 'whu'] },

  // --- La Liga ---
  { canonical: 'Real Madrid', aliases: ['real madrid', 'rm', 'madrid'] },
  { canonical: 'Barcelona', aliases: ['barcelona', 'barca', 'barça', 'fc barcelona'] },
  { canonical: 'Atletico Madrid', aliases: ['atletico madrid', 'atletico', 'atm'] },
  { canonical: 'Sevilla', aliases: ['sevilla', 'sevilla fc'] },
  { canonical: 'Real Sociedad', aliases: ['real sociedad', 'sociedad'] },
  { canonical: 'Villarreal', aliases: ['villarreal', 'villarreal cf'] },
  { canonical: 'Real Betis', aliases: ['real betis', 'betis'] },
  { canonical: 'Valencia', aliases: ['valencia', 'valencia cf'] },
  { canonical: 'Athletic Bilbao', aliases: ['athletic bilbao', 'athletic', 'bilbao'] },
  { canonical: 'Girona', aliases: ['girona', 'girona fc'] },

  // --- Serie A ---
  { canonical: 'Inter Milan', aliases: ['inter milan', 'inter', 'internazionale'] },
  { canonical: 'AC Milan', aliases: ['ac milan', 'milan', 'acm'] },
  { canonical: 'Juventus', aliases: ['juventus', 'juv', 'juve'] },
  { canonical: 'Napoli', aliases: ['napoli', 'ssc napoli'] },
  { canonical: 'Roma', aliases: ['roma', 'as roma', 'asr'] },
  { canonical: 'Lazio', aliases: ['lazio', 'ss lazio'] },
  { canonical: 'Atalanta', aliases: ['atalanta', 'atalanta bc'] },

  // --- Bundesliga ---
  { canonical: 'Bayern Munich', aliases: ['bayern munich', 'bayern', 'bayern münich', 'fcb'] },
  { canonical: 'Borussia Dortmund', aliases: ['borussia dortmund', 'dortmund', 'bvb'] },
  { canonical: 'RB Leipzig', aliases: ['rb leipzig', 'leipzig'] },
  { canonical: 'Bayer Leverkusen', aliases: ['bayer leverkusen', 'leverkusen', 'bayer 04'] },

  // --- Ligue 1 ---
  { canonical: 'Paris Saint-Germain', aliases: ['paris saint-germain', 'paris saint germain', 'psg', 'paris'] },
  { canonical: 'Marseille', aliases: ['marseille', 'olympique de marseille', 'om'] },
  { canonical: 'Lyon', aliases: ['lyon', 'olympique lyonnais', 'ol'] },

  // --- National Teams ---
  { canonical: 'Brazil', aliases: ['brazil', 'brasil'] },
  { canonical: 'Argentina', aliases: ['argentina'] },
  { canonical: 'France', aliases: ['france'] },
  { canonical: 'Germany', aliases: ['germany', 'deutschland'] },
  { canonical: 'Spain', aliases: ['spain', 'españa'] },
  { canonical: 'England', aliases: ['england'] },
  { canonical: 'Italy', aliases: ['italy', 'italia'] },
  { canonical: 'Portugal', aliases: ['portugal'] },
  { canonical: 'Netherlands', aliases: ['netherlands', 'holland'] },
  { canonical: 'Belgium', aliases: ['belgium', 'belgie', 'belgië'] },
];

// ---------------------------------------------------------------------------
// Team name helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a team name for comparison: lowercase, trim, collapse whitespace,
 * strip common noise characters.
 */
export function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Attempt to match an OCR-extracted name against the known teams database.
 * Returns the canonical name or null if no match.
 */
export function matchTeamName(ocrName: string): string | null {
  const normalized = normalizeTeamName(ocrName);

  if (!normalized || normalized.length < 2) return null;

  // Direct alias match
  for (const team of KNOWN_TEAMS) {
    for (const alias of team.aliases) {
      if (normalized === normalizeTeamName(alias)) {
        return team.canonical;
      }
    }
  }

  // Substring match (OCR name contains an alias or vice versa)
  for (const team of KNOWN_TEAMS) {
    for (const alias of team.aliases) {
      const normAlias = normalizeTeamName(alias);
      if (normalized.includes(normAlias) || normAlias.includes(normalized)) {
        return team.canonical;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Levenshtein distance (used by verificationService too)
// ---------------------------------------------------------------------------

/**
 * Compute Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

/**
 * Normalized similarity score between 0 and 1 (1 = identical).
 */
export function stringSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

// ---------------------------------------------------------------------------
// Orientation detection
// ---------------------------------------------------------------------------

function detectOrientation(lines: string[]): MatchOrientation {
  const allText = lines.join(' ').toUpperCase();

  if (/\bFULL\s*TIME\b/.test(allText) || /\bFT\b/.test(allText)) return 'FULL_TIME';
  if (/\bHALF\s*TIME\b/.test(allText) || /\bHT\b/.test(allText)) return 'HALF_TIME';
  if (/\bLIVE\b/.test(allText) || /\b\d{1,2}:\d{2}\b/.test(allText)) return 'LIVE';

  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Score extraction
// ---------------------------------------------------------------------------

function extractScore(lines: string[]): { p1: number | null; p2: number | null } {
  // Patterns: "2 - 1", "2–1", "2:1", "2 -1", "2- 1"
  const scorePatterns = [
    /(\d{1,2})\s*[-–—:]\s*(\d{1,2})/,
    /(\d{1,2})\s+(\d{1,2})\s*$/,           // two numbers at end of line
  ];

  for (const line of lines) {
    for (const pattern of scorePatterns) {
      const match = line.match(pattern);
      if (match) {
        const p1 = parseInt(match[1], 10);
        const p2 = parseInt(match[2], 10);
        if (p1 <= 99 && p2 <= 99) {
          return { p1, p2 };
        }
      }
    }
  }

  return { p1: null, p2: null };
}

// ---------------------------------------------------------------------------
// Player name extraction (3 strategies)
// ---------------------------------------------------------------------------

/**
 * Strategy 1: Names on the same line as the score (e.g. "Arsenal 2 - 1 Chelsea")
 */
function extractNamesSameLineAsScore(lines: string[]): { p1: string; p2: string } | null {
  const scorePattern = /(\d{1,2})\s*[-–—:]\s*(\d{1,2})/;

  for (const line of lines) {
    const match = line.match(scorePattern);
    if (match) {
      const beforeScore = line.substring(0, line.indexOf(match[0])).trim();
      const afterScore = line.substring(line.indexOf(match[0]) + match[0].length).trim();

      if (beforeScore.length >= 2 && afterScore.length >= 2) {
        return { p1: beforeScore, p2: afterScore };
      }
    }
  }
  return null;
}

/**
 * Strategy 2: Names on lines immediately adjacent to the score line
 */
function extractNamesAdjacentLines(lines: string[]): { p1: string; p2: string } | null {
  const scorePattern = /(\d{1,2})\s*[-–—:]\s*(\d{1,2})/;

  for (let i = 0; i < lines.length; i++) {
    if (scorePattern.test(lines[i])) {
      // Look for names above and below
      let p1 = '';
      let p2 = '';

      // Scan up to 3 lines above for a plausible name
      for (let j = Math.max(0, i - 3); j < i; j++) {
        const candidate = lines[j].trim();
        if (isPlausibleTeamName(candidate)) {
          p1 = candidate;
          break;
        }
      }

      // Scan up to 3 lines below
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
        const candidate = lines[j].trim();
        if (isPlausibleTeamName(candidate)) {
          p2 = candidate;
          break;
        }
      }

      if (p1 && p2) return { p1, p2 };
    }
  }
  return null;
}

/**
 * Strategy 3: Collect all plausible team names from the entire text, pick the first two
 */
function extractNamesCollectAll(lines: string[]): { p1: string; p2: string } | null {
  const names: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (isPlausibleTeamName(trimmed)) {
      names.push(trimmed);
    }
  }

  if (names.length >= 2) {
    return { p1: names[0], p2: names[1] };
  }
  if (names.length === 1) {
    return { p1: names[0], p2: '' };
  }
  return null;
}

function isPlausibleTeamName(text: string): boolean {
  if (!text || text.length < 2 || text.length > 40) return false;
  // Must contain at least one letter
  if (!/[a-zA-Z]/.test(text)) return false;
  // Must not be purely numeric
  if (/^\d+$/.test(text)) return false;
  // Must not look like a score or time
  if (/^\d{1,2}\s*[-–—:]\s*\d{1,2}$/.test(text)) return false;
  if (/^\d{1,2}:\d{2}$/.test(text)) return false;
  // Must not be a stat label
  const statLabels = ['possession', 'shots', 'fouls', 'corners', 'offsides', 'passes', 'pass accuracy'];
  if (statLabels.includes(text.toLowerCase())) return false;

  return true;
}

function extractPlayerNames(lines: string[]): { p1: string; p2: string } {
  // Try strategies in order of reliability
  const s1 = extractNamesSameLineAsScore(lines);
  if (s1) return s1;

  const s2 = extractNamesAdjacentLines(lines);
  if (s2) return s2;

  const s3 = extractNamesCollectAll(lines);
  if (s3) return s3;

  return { p1: '', p2: '' };
}

// ---------------------------------------------------------------------------
// Stats extraction
// ---------------------------------------------------------------------------

function extractStats(lines: string[]): EFOTBOCRResult['stats'] {
  const allText = lines.join('\n');

  // Possession: "52% - 48%" or "Possession 52 48" or "52% 48%"
  let possession: StatTuple | null = null;
  const possessionPatterns = [
    /possession[:\s]*(\d{1,3})%?\s*[-–—:\s]\s*(\d{1,3})%?/i,
    /(\d{1,3})%\s*[-–—]\s*(\d{1,3})%/,
  ];
  for (const pattern of possessionPatterns) {
    const match = allText.match(pattern);
    if (match) {
      possession = { player1: parseInt(match[1], 10), player2: parseInt(match[2], 10) };
      break;
    }
  }

  // Shots: "Shots 12 - 8" or "12 - 8" near "shots"
  let shots: StatTuple | null = null;
  const shotsPatterns = [
    /shots?[:\s]*(\d{1,3})\s*[-–—:\s]\s*(\d{1,3})/i,
  ];
  for (const pattern of shotsPatterns) {
    const match = allText.match(pattern);
    if (match) {
      shots = { player1: parseInt(match[1], 10), player2: parseInt(match[2], 10) };
      break;
    }
  }

  // Fouls: "Fouls 10 - 14" or similar
  let fouls: StatTuple | null = null;
  const foulsPatterns = [
    /fouls?[:\s]*(\d{1,3})\s*[-–—:\s]\s*(\d{1,3})/i,
  ];
  for (const pattern of foulsPatterns) {
    const match = allText.match(pattern);
    if (match) {
      fouls = { player1: parseInt(match[1], 10), player2: parseInt(match[2], 10) };
      break;
    }
  }

  return { possession, shots, fouls };
}

// ---------------------------------------------------------------------------
// Match time extraction
// ---------------------------------------------------------------------------

function extractMatchTime(lines: string[]): string | null {
  // Look for patterns like "90:00", "45:00", "12:34"
  const timePattern = /\b([0-9]{1,2}):([0-5][0-9])\b/;

  for (const line of lines) {
    const match = line.match(timePattern);
    if (match) {
      const minutes = parseInt(match[1], 10);
      if (minutes <= 120) {
        // Reasonable match duration
        return match[0];
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Competition extraction
// ---------------------------------------------------------------------------

const KNOWN_COMPETITIONS = [
  'Premier League',
  'La Liga',
  'Serie A',
  'Bundesliga',
  'Ligue 1',
  'Champions League',
  'Europa League',
  'Conference League',
  'FA Cup',
  'Copa del Rey',
  'Coppa Italia',
  'DFB-Pokal',
  'Coupe de France',
  'World Cup',
  'European Championship',
  'Euros',
  'UEFA Nations League',
  'FIFA Club World Cup',
  'eFootball',
  'eFootball League',
];

function extractCompetition(lines: string[]): string | null {
  const allText = lines.join(' ');

  for (const comp of KNOWN_COMPETITIONS) {
    const escaped = comp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    if (pattern.test(allText)) {
      return comp;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

function calculateConfidence(result: {
  hasScore: boolean;
  hasNames: boolean;
  hasOrientation: boolean;
  hasStats: boolean;
  hasTime: boolean;
}): number {
  let score = 0;

  if (result.hasScore) score += 45;
  if (result.hasNames) score += 25;
  if (result.hasOrientation) score += 15;
  if (result.hasStats) score += 10;
  if (result.hasTime) score += 5;

  return score;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse OCR-extracted text into a structured EFOTBOCRResult.
 * Uses multiple extraction strategies with confidence scoring.
 */
export function parseEFOTBScreenshot(text: string): EFOTBOCRResult {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const orientation = detectOrientation(lines);
  const { p1: player1Score, p2: player2Score } = extractScore(lines);
  const { p1: player1Name, p2: player2Name } = extractPlayerNames(lines);
  const stats = extractStats(lines);
  const matchTime = extractMatchTime(lines);
  const competition = extractCompetition(lines);

  const hasScore = player1Score !== null && player2Score !== null;
  const hasNames = player1Name.length > 0 && player2Name.length > 0;
  const hasOrientation = orientation !== 'UNKNOWN';
  const hasStats = stats.possession !== null || stats.shots !== null || stats.fouls !== null;
  const hasTime = matchTime !== null;

  const confidence = calculateConfidence({
    hasScore,
    hasNames,
    hasOrientation,
    hasStats,
    hasTime,
  });

  return {
    player1Name,
    player2Name,
    player1Score,
    player2Score,
    matchTime,
    competition,
    stats,
    confidence,
    rawText: text,
    orientation,
  };
}

// ---------------------------------------------------------------------------
// Singleton worker pool
// ---------------------------------------------------------------------------

let workerPool: Awaited<ReturnType<typeof createWorker>> | null = null;
let workerPromise: Promise<Awaited<ReturnType<typeof createWorker>>> | null = null;

/**
 * Get or create the singleton Tesseract worker.
 * Worker initialization is expensive (~2s), so we reuse it.
 */
async function getWorker(): Promise<Awaited<ReturnType<typeof createWorker>>> {
  if (workerPool) return workerPool;

  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    const worker = await createWorker('eng');
    workerPool = worker;
    return worker;
  })();

  return workerPromise;
}

/**
 * Shutdown the worker pool. Useful for testing and graceful shutdown.
 */
export async function shutdownWorker(): Promise<void> {
  if (workerPool) {
    await workerPool.terminate();
    workerPool = null;
    workerPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run OCR on an image buffer and parse the result.
 * Uses the singleton Tesseract worker pool.
 */
export async function ocrScreenshot(buffer: Buffer): Promise<EFOTBOCRResult> {
  const worker = await getWorker();

  const result = await worker.recognize(buffer);
  const text = result.data.text;

  return parseEFOTBScreenshot(text);
}
