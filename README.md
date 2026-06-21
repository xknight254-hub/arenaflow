# ArenaFlow

Tournament bracket engine with built-in result verification.

## Features

- **4 bracket formats**: Knockout, League (round-robin), Multi-bracket (group + knockout), Swiss
- **OCR-powered result verification**: Upload eFootball match screenshots → automatic score extraction
- **Fraud detection**: Duplicate screenshot detection, team validation, impossible score checks, rate limiting
- **Confidence scoring**: Weighted multi-signal confidence (team match 40%, OCR 20%, score visibility 20%, fraud penalty 20%)
- **Auto-approval**: ≥90% confidence auto-submits, 55-89% opponent review, <55% rejected
- **REST API**: Full HTTP API for tournament lifecycle management
- **SQLite**: Zero-config database, file-based, WAL mode

## Quick Start

```bash
npm install
npm run dev
```

Server runs on `http://localhost:3000`.

## API Reference

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login, get JWT |
| GET | `/api/auth/me` | Get current user |

### Tournaments
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/tournaments` | Create tournament |
| GET | `/api/tournaments` | List public tournaments |
| GET | `/api/tournaments/:id` | Get tournament + participants |
| POST | `/api/tournaments/:id/join` | Join tournament |
| POST | `/api/tournaments/:id/start` | Start tournament (admin) |
| GET | `/api/tournaments/:id/matches` | Get bracket matches |
| GET | `/api/tournaments/:id/standings` | Get standings |

### Matches
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/matches/:id` | Get match details |
| POST | `/api/matches/:id/submit` | Submit result |
| POST | `/api/matches/:id/confirm` | Opponent confirms |
| POST | `/api/matches/:id/dispute` | Opponent disputes |
| PATCH | `/api/matches/:id/resolve` | Admin resolves dispute |

### OCR & Verification
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/ocr/analyze` | OCR screenshot (preview) |
| POST | `/api/matches/:id/verify` | Full verification pipeline |
| POST | `/api/matches/:id/auto-submit` | OCR + auto-submit if confident |

## Tournament Formats

### Knockout
Single elimination with standard seeding (1v16, 2v15, ...). Auto-pads to next power of 2 with byes.

### League
Round-robin. Every player plays every other player once. Standings by wins, then goal difference.

### Multi-bracket
Group stage (round-robin within groups) → knockout (top 2 from each group advance).

### Swiss
Players paired by cumulative score each round. N-1 rounds for N players.

## Verification Pipeline

1. Upload screenshot → Tesseract OCR
2. Parse eFootball result screen (scores, player names, stats, competition)
3. Validate teams against database fixture (direct → canonical → fuzzy match)
4. Run fraud detection (duplicates, wrong teams, impossible scores, frequency)
5. Calculate confidence score
6. Auto-approve / opponent review / reject

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `JWT_SECRET` | `arenaflow-dev-secret` | JWT signing key (change in production) |

## License

MIT
