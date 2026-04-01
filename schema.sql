-- Database creation is handled by server.js using DB_NAME from the environment.

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_name VARCHAR(32) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  status ENUM('active', 'banned') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_servers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  server_code VARCHAR(32) NOT NULL UNIQUE,
  server_name VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  status ENUM('online', 'maintenance') NOT NULL DEFAULT 'online',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS game_roles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  server_id BIGINT UNSIGNED NOT NULL,
  role_name VARCHAR(24) NOT NULL,
  class_name VARCHAR(24) NOT NULL,
  level INT NOT NULL DEFAULT 1,
  gold INT NOT NULL DEFAULT 1000,
  diamond INT NOT NULL DEFAULT 100,
  power_score INT NOT NULL DEFAULT 120,
  stage_progress INT NOT NULL DEFAULT 1,
  arena_points INT NOT NULL DEFAULT 0,
  last_login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_game_roles_stage_progress (stage_progress DESC),
  INDEX idx_game_roles_arena_points (arena_points DESC),
  CONSTRAINT fk_game_roles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_game_roles_server FOREIGN KEY (server_id) REFERENCES game_servers(id) ON DELETE CASCADE,
  CONSTRAINT uk_game_roles_server_name UNIQUE (server_id, role_name)
);

CREATE TABLE IF NOT EXISTS role_game_saves (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  role_id BIGINT UNSIGNED NOT NULL UNIQUE,
  save_data LONGTEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_role_game_saves_role FOREIGN KEY (role_id) REFERENCES game_roles(id) ON DELETE CASCADE
);

INSERT INTO game_servers (server_code, server_name, sort_order, status)
VALUES
  ('s1', '一区 星辉之城', 1, 'online'),
  ('s2', '二区 苍穹回廊', 2, 'online'),
  ('s3', '三区 深渊裂隙', 3, 'maintenance')
ON DUPLICATE KEY UPDATE
  server_name = VALUES(server_name),
  sort_order = VALUES(sort_order),
  status = VALUES(status);
