import { Router, Request, Response } from 'express';
import { authenticateToken, requireAdmin, generateToken, hashPassword, comparePassword, getUserByUsername, createUser } from '../middleware/auth.js';
import type { AuthRequest } from '../types.js';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  const { username, email, password, first_name, last_name } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email, and password required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = getUserByUsername(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const existingEmail = getUserByUsername(email);
  if (existingEmail) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const user = createUser(username, email, passwordHash, first_name, last_name);
    const token = generateToken(user);
    res.status(201).json({
      user: { id: user.id, username: user.username, email: user.email },
      token,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Registration failed', details: error.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  const user = getUserByUsername(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await comparePassword(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = generateToken(user);
  res.json({
    user: { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin },
    token,
  });
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req: Request & AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.user });
});

export default router;
