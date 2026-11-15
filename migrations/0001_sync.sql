-- 账户、登录会话和同步快照由 Worker 访问，密码只保存派生值。
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE TABLE snapshots (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE auth_attempts (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
