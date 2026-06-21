import { Request } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import type { AuthRequest, User } from '../types.js';

const JWT_SECRET = process.env.JWT_SECRET || 'arenaflow-dev-secret-change-in-production';
const SALT_ROUNDS = 12;

export function generateToken(user: { id: number; username: string; is_admin: number; is_super_admin: number }): string {
  return jwt.sign(
    { id: user.id, username: user.username, is_admin: user.is_admin, is_super_admin: user.is_super_admin },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function verifyToken(token: string): AuthRequest['user'] | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthRequest['user'];
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function authenticateToken(req: Request & AuthRequest, res: any, next: any): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const user = verifyToken(token);
  if (!user) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  req.user = user;
  next();
}

export function requireAdmin(req: Request & AuthRequest, res: any, next: any): void {
  if (!req.user?.is_admin && !req.user?.is_super_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export function requireSuperAdmin(req: Request & AuthRequest, res: any, next: any): void {
  if (!req.user?.is_super_admin) {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

export function getUserByUsername(username: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
}

export function getUserById(id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function createUser(username: string, email: string, passwordHash: string, firstName?: string, lastName?: string): User {
  const result = db.prepare(
    'INSERT INTO users (username, email, password_hash, first_name, last_name) VALUES (?, ?, ?, ?, ?)'
  ).run(username, email, passwordHash, firstName || null, lastName || null);
  return getUserById(result.lastInsertRowid as number)!;
}
