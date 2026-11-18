'use strict';
/**
 * 用户认证系统
 * 零依赖：自实现密码哈希、Token 管理
 */

const crypto = require('node:crypto');

// ---------- 数据存储 ----------
const users = new Map();      // userId -> User
const tokens = new Map();     // token -> { userId, expiresAt }
const usernameIndex = new Map(); // username -> userId

// ---------- 密码哈希 ----------
function hashPassword(password) {
  // 简单但安全的哈希：SHA256 + 固定盐
  // 生产环境应该用 bcrypt，但这里零依赖
  const salt = 'board-games-salt-2024';
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}

function verifyPassword(password, hash) {
  return hashPassword(password) === hash;
}

// ---------- Token 管理 ----------
function generateToken() {
  return crypto.randomUUID();
}

function createToken(userId) {
  const token = generateToken();
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 天
  tokens.set(token, { userId, expiresAt });
  return token;
}

function verifyToken(token) {
  const data = tokens.get(token);
  if (!data) return null;
  if (Date.now() > data.expiresAt) {
    tokens.delete(token);
    return null;
  }
  return data.userId;
}

function revokeToken(token) {
  tokens.delete(token);
}

// ---------- 用户管理 ----------
function createUser({ username, password, displayName }) {
  // 验证
  if (!username || username.length < 3 || username.length > 20) {
    throw new Error('用户名必须 3-20 个字符');
  }
  if (!password || password.length < 6) {
    throw new Error('密码至少 6 个字符');
  }
  if (usernameIndex.has(username.toLowerCase())) {
    throw new Error('用户名已被占用');
  }
  
  const userId = crypto.randomUUID();
  const user = {
    id: userId,
    username,
    passwordHash: hashPassword(password),
    displayName: displayName || username,
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
    stats: {
      gamesPlayed: 0,
      wins: 0,
      forestGames: 0,
      photoGames: 0,
    },
  };
  
  users.set(userId, user);
  usernameIndex.set(username.toLowerCase(), userId);
  return user;
}

function getUserById(userId) {
  return users.get(userId);
}

function getUserByUsername(username) {
  const userId = usernameIndex.get(username.toLowerCase());
  return userId ? users.get(userId) : null;
}

function updateUserStats(userId, updates) {
  const user = users.get(userId);
  if (!user) return;
  Object.assign(user.stats, updates);
}

// ---------- 公开函数 ----------
function sanitizeUser(user) {
  // 不返回密码哈希
  const { passwordHash, ...safe } = user;
  return safe;
}

module.exports = {
  createUser,
  getUserById,
  getUserByUsername,
  updateUserStats,
  verifyPassword,
  createToken,
  verifyToken,
  revokeToken,
  sanitizeUser,
};
