const crypto = require("crypto");
const path = require("path");
const fs = require("fs/promises");

const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");
const express = require("express");
const mysql = require("mysql2/promise");

dotenv.config();

const PORT = Number(process.env.PORT || 4000);
const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || "root";
const DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_NAME = process.env.DB_NAME || "dimension_brawl";
const PERMANENT_SESSION_EXPIRES_AT = new Date("2099-12-31T23:59:59.000Z");

const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true
});

const app = express();

app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.resolve(__dirname)));

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function isValidAccountName(accountName) {
  return /^[\u4e00-\u9fa5A-Za-z0-9]{2,24}$/.test(accountName);
}

function isValidRoleName(name) {
  return /^[\u4e00-\u9fa5A-Za-z0-9_]{2,24}$/.test(name);
}

function readBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice(7).trim();
}

async function ensureDatabaseReady() {
  const schemaPath = path.resolve(__dirname, "schema.sql");
  const rawSchema = await fs.readFile(schemaPath, "utf8");
  const bodySql = rawSchema
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim().toUpperCase();
      return !trimmed.startsWith("CREATE DATABASE ") && !trimmed.startsWith("USE ");
    })
    .join("\n")
    .trim();

  const connection = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    multipleStatements: true
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.query(`USE \`${DB_NAME}\``);
    if (bodySql) await connection.query(bodySql);
  } finally {
    await connection.end();
  }
}

async function listServers() {
  const [rows] = await pool.execute(
    `SELECT id, server_code AS serverCode, server_name AS serverName, sort_order AS sortOrder, status
     FROM game_servers
     ORDER BY sort_order ASC, id ASC`
  );
  return rows;
}

async function listRolesByUserId(userId) {
  const [rows] = await pool.execute(
    `SELECT r.id, r.server_id AS serverId, s.server_name AS serverName, s.server_code AS serverCode,
            r.role_name AS roleName, r.class_name AS className, r.level, r.gold, r.diamond,
            r.power_score AS powerScore, r.last_login_at AS lastLoginAt, r.created_at AS createdAt
     FROM game_roles r
     INNER JOIN game_servers s ON s.id = r.server_id
     WHERE r.user_id = :userId
     ORDER BY s.sort_order ASC, r.created_at ASC`,
    { userId }
  );
  return rows;
}

async function buildProfile(user) {
  const [servers, roles] = await Promise.all([
    listServers(),
    listRolesByUserId(user.id)
  ]);
  return { user, servers, roles };
}

async function ensureColumnExists(tableName, columnName, definitionSql) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS total
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = :tableName
       AND column_name = :columnName`,
    { tableName, columnName }
  );

  if (Number(rows[0].total || 0) > 0) return;
  await pool.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
}

async function ensureIndexExists(tableName, indexName, definitionSql) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS total
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = :tableName
       AND index_name = :indexName`,
    { tableName, indexName }
  );

  if (Number(rows[0].total || 0) > 0) return;
  await pool.execute(`ALTER TABLE ${tableName} ADD INDEX ${indexName} ${definitionSql}`);
}

async function ensureSchemaUpgrades() {
  await ensureColumnExists("game_roles", "stage_progress", "INT NOT NULL DEFAULT 1 AFTER power_score");
  await ensureColumnExists("game_roles", "arena_points", "INT NOT NULL DEFAULT 0 AFTER stage_progress");
  await ensureIndexExists("game_roles", "idx_game_roles_stage_progress", "(stage_progress DESC)");
  await ensureIndexExists("game_roles", "idx_game_roles_arena_points", "(arena_points DESC)");
  await pool.execute(
    `UPDATE game_roles r
     LEFT JOIN role_game_saves rs ON rs.role_id = r.id
     SET r.stage_progress = COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(rs.save_data, '$.stage')) AS UNSIGNED), 1),
         r.arena_points = COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(rs.save_data, '$.arena.points')) AS UNSIGNED), 0)
     WHERE rs.role_id IS NOT NULL
       AND (
         r.stage_progress <= 1
         OR r.arena_points <=> 0
       )`
  );
}

function normalizeArenaSave(saveData) {
  if (!saveData || typeof saveData !== "object" || Array.isArray(saveData)) return null;
  const formation = Array.isArray(saveData.formation)
    ? saveData.formation.filter((id) => typeof id === "string" && id).slice(0, 6)
    : [];
  const roster = saveData.roster && typeof saveData.roster === "object" ? saveData.roster : {};
  if (!formation.length || !Object.keys(roster).length) return null;
  return {
    formation,
    roster,
    teamLv: Math.max(1, Number(saveData.teamLv || 1)),
    rebirth: Math.max(0, Number(saveData.rebirth || 0))
  };
}

async function authRequired(req, res, next) {
  const token = readBearerToken(req);
  if (!token) return res.status(401).json({ message: "AUTH_REQUIRED" });

  const [rows] = await pool.execute(
    `SELECT s.user_id, s.expires_at, u.account_name, u.status, u.created_at
     FROM user_sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.token = :token
     LIMIT 1`,
    { token }
  );

  if (!rows.length) return res.status(401).json({ message: "SESSION_NOT_FOUND" });

  const session = rows[0];
  if (session.status !== "active") return res.status(403).json({ message: "ACCOUNT_DISABLED" });

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await pool.execute("DELETE FROM user_sessions WHERE token = :token", { token });
    return res.status(401).json({ message: "SESSION_EXPIRED" });
  }

  req.user = {
    id: session.user_id,
    accountName: session.account_name,
    createdAt: session.created_at
  };
  req.sessionToken = token;
  next();
}

async function roleRequired(req, res, next) {
  const roleId = Number(req.headers["x-role-id"] || req.query.roleId || req.body.roleId || 0);
  if (!roleId) return res.status(400).json({ message: "ROLE_ID_REQUIRED" });

  const [rows] = await pool.execute(
    `SELECT r.id, r.user_id AS userId, r.server_id AS serverId, s.server_name AS serverName, s.server_code AS serverCode,
            r.role_name AS roleName, r.class_name AS className, r.level, r.gold, r.diamond,
            r.power_score AS powerScore, r.last_login_at AS lastLoginAt, r.created_at AS createdAt
     FROM game_roles r
     INNER JOIN game_servers s ON s.id = r.server_id
     WHERE r.id = :roleId
       AND r.user_id = :userId
     LIMIT 1`,
    { roleId, userId: req.user.id }
  );

  if (!rows.length) return res.status(404).json({ message: "ROLE_NOT_FOUND" });
  req.role = rows[0];
  next();
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, mysql: "connected", serverTime: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, mysql: "disconnected", message: error.message });
  }
});

app.post("/api/auth/register", async (req, res) => {
  const accountName = String(req.body.accountName || "").trim();
  const password = String(req.body.password || "");

  if (!isValidAccountName(accountName)) {
    return res.status(400).json({ message: "ACCOUNT_NAME_INVALID" });
  }
  if (password.length < 6 || password.length > 72) {
    return res.status(400).json({ message: "PASSWORD_INVALID" });
  }

  const [exists] = await pool.execute(
    "SELECT id FROM users WHERE account_name = :accountName LIMIT 1",
    { accountName }
  );
  if (exists.length) return res.status(409).json({ message: "ACCOUNT_EXISTS" });

  const passwordHash = await bcrypt.hash(password, 10);
  await pool.execute(
    "INSERT INTO users (account_name, password_hash) VALUES (:accountName, :passwordHash)",
    { accountName, passwordHash }
  );

  res.status(201).json({ message: "REGISTER_OK" });
});

app.post("/api/auth/login", async (req, res) => {
  const accountName = String(req.body.accountName || "").trim();
  const password = String(req.body.password || "");

  const [rows] = await pool.execute(
    `SELECT id, password_hash, status
     FROM users
     WHERE account_name = :accountName
     LIMIT 1`,
    { accountName }
  );

  if (!rows.length) return res.status(401).json({ message: "LOGIN_INVALID" });

  const user = rows[0];
  if (user.status !== "active") return res.status(403).json({ message: "ACCOUNT_DISABLED" });

  const matched = await bcrypt.compare(password, user.password_hash);
  if (!matched) return res.status(401).json({ message: "LOGIN_INVALID" });

  const token = createToken();
  const expiresAt = PERMANENT_SESSION_EXPIRES_AT;

  await pool.execute(
    "INSERT INTO user_sessions (user_id, token, expires_at) VALUES (:userId, :token, :expiresAt)",
    { userId: user.id, token, expiresAt }
  );

  res.json({ message: "LOGIN_OK", token, expiresAt: expiresAt.toISOString() });
});

app.get("/api/auth/me", authRequired, async (req, res) => {
  res.json(await buildProfile(req.user));
});

app.get("/api/leaderboard", authRequired, async (req, res) => {
  const serverId = Number(req.query.serverId || 0);
  const requestedType = String(req.query.type || "power").trim();
  const leaderboardType = ["power", "stage", "arena"].includes(requestedType) ? requestedType : "power";
  const params = {};
  let whereSql = "";
  let extraJoinSql = "";
  let metricSql = "r.power_score";
  let orderSql = "r.power_score DESC, r.level DESC, r.updated_at ASC";
  let metricAlias = "powerScore";

  if (serverId) {
    whereSql = "WHERE r.server_id = :serverId";
    params.serverId = serverId;
  }

  if (leaderboardType === "stage") {
    metricSql = "r.stage_progress";
    orderSql = "r.stage_progress DESC, r.power_score DESC, r.updated_at ASC";
    metricAlias = "stage";
  } else if (leaderboardType === "arena") {
    metricSql = "r.arena_points";
    orderSql = "r.arena_points DESC, r.power_score DESC, r.updated_at ASC";
    metricAlias = "arenaPoints";
  }

  const [rows] = await pool.execute(
    `SELECT r.id, r.role_name AS roleName, r.class_name AS className, r.level, r.gold, r.diamond,
            r.power_score AS powerScore, r.last_login_at AS lastLoginAt,
            ${metricSql} AS ${metricAlias},
            s.id AS serverId, s.server_name AS serverName, s.server_code AS serverCode,
            u.account_name AS accountName
     FROM game_roles r
     INNER JOIN game_servers s ON s.id = r.server_id
     INNER JOIN users u ON u.id = r.user_id
     ${extraJoinSql}
     ${whereSql}
     ORDER BY ${orderSql}
     LIMIT 50`,
    params
  );

  res.json({
    type: leaderboardType,
    serverId: serverId || null,
    rankings: rows
  });
});

app.get("/api/arena/opponents", authRequired, roleRequired, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 3), 1), 12);
  const [rows] = await pool.execute(
    `SELECT r.id, r.role_name AS roleName, r.level, r.gold, r.diamond,
            r.power_score AS powerScore, r.last_login_at AS lastLoginAt,
            s.id AS serverId, s.server_name AS serverName, s.server_code AS serverCode,
            u.account_name AS accountName,
            rs.save_data AS saveData,
            CASE WHEN r.server_id = :serverId THEN 0 ELSE 1 END AS serverPriority,
            ABS(r.power_score - :powerScore) AS powerGap
     FROM game_roles r
     INNER JOIN users u ON u.id = r.user_id
     INNER JOIN game_servers s ON s.id = r.server_id
     INNER JOIN role_game_saves rs ON rs.role_id = r.id
     WHERE r.id <> :roleId
       AND r.user_id <> :userId
       AND u.status = 'active'
     ORDER BY serverPriority ASC, powerGap ASC, r.power_score DESC, r.last_login_at DESC
     LIMIT 36`,
    {
      roleId: req.role.id,
      userId: req.user.id,
      serverId: req.role.serverId,
      powerScore: Number(req.role.powerScore || 0)
    }
  );

  const opponents = [];
  for (const row of rows) {
    let parsed = null;
    try {
      parsed = JSON.parse(row.saveData);
    } catch (error) {
      parsed = null;
    }
    const arenaSave = normalizeArenaSave(parsed);
    if (!arenaSave) continue;
    opponents.push({
      id: row.id,
      roleName: row.roleName,
      accountName: row.accountName,
      serverId: row.serverId,
      serverName: row.serverName,
      serverCode: row.serverCode,
      level: row.level,
      powerScore: row.powerScore,
      lastLoginAt: row.lastLoginAt,
      teamLv: arenaSave.teamLv,
      rebirth: arenaSave.rebirth,
      formation: arenaSave.formation,
      roster: arenaSave.roster
    });
    if (opponents.length >= limit) break;
  }

  res.json({ opponents });
});

app.post("/api/roles", authRequired, async (req, res) => {
  const serverId = Number(req.body.serverId || 0);
  const roleName = String(req.body.roleName || "").trim();
  if (!serverId) return res.status(400).json({ message: "SERVER_REQUIRED" });
  if (!isValidRoleName(roleName)) return res.status(400).json({ message: "ROLE_NAME_INVALID" });

  const [serverRows] = await pool.execute(
    "SELECT id, status FROM game_servers WHERE id = :serverId LIMIT 1",
    { serverId }
  );

  if (!serverRows.length) return res.status(404).json({ message: "SERVER_NOT_FOUND" });
  if (serverRows[0].status !== "online") return res.status(400).json({ message: "SERVER_NOT_AVAILABLE" });

  const [countRows] = await pool.execute(
    "SELECT COUNT(*) AS total FROM game_roles WHERE user_id = :userId AND server_id = :serverId",
    { userId: req.user.id, serverId }
  );
  if (countRows[0].total >= 3) return res.status(400).json({ message: "ROLE_LIMIT_REACHED" });

  const [exists] = await pool.execute(
    "SELECT id FROM game_roles WHERE server_id = :serverId AND role_name = :roleName LIMIT 1",
    { serverId, roleName }
  );
  if (exists.length) return res.status(409).json({ message: "ROLE_NAME_EXISTS" });

  const [insertResult] = await pool.execute(
    `INSERT INTO game_roles (user_id, server_id, role_name, class_name)
     VALUES (:userId, :serverId, :roleName, :className)`,
    { userId: req.user.id, serverId, roleName, className: "" }
  );

  await pool.execute(
    `INSERT INTO role_game_saves (role_id, save_data)
     VALUES (:roleId, :saveData)`,
    { roleId: insertResult.insertId, saveData: JSON.stringify({}) }
  );

  res.status(201).json({
    message: "ROLE_CREATE_OK",
    roles: await listRolesByUserId(req.user.id)
  });
});

app.post("/api/roles/:roleId/enter", authRequired, async (req, res) => {
  req.body.roleId = Number(req.params.roleId || 0);
  return roleRequired(req, res, async () => {
    await pool.execute(
      "UPDATE game_roles SET last_login_at = CURRENT_TIMESTAMP WHERE id = :roleId",
      { roleId: req.role.id }
    );
    res.json({ message: "ROLE_ENTER_OK", role: req.role });
  });
});

app.get("/api/game/save", authRequired, roleRequired, async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT save_data AS saveData, updated_at AS updatedAt
     FROM role_game_saves
     WHERE role_id = :roleId
     LIMIT 1`,
    { roleId: req.role.id }
  );

  if (!rows.length) {
    return res.json({ role: req.role, saveData: null, updatedAt: null });
  }

  let saveData = null;
  try {
    saveData = JSON.parse(rows[0].saveData);
  } catch (error) {
    return res.status(500).json({ message: "SAVE_DATA_CORRUPTED" });
  }

  res.json({ role: req.role, saveData, updatedAt: rows[0].updatedAt });
});

app.put("/api/game/save", authRequired, roleRequired, async (req, res) => {
  const saveData = req.body.saveData;
  if (!saveData || typeof saveData !== "object" || Array.isArray(saveData)) {
    return res.status(400).json({ message: "SAVE_DATA_INVALID" });
  }

  const payload = JSON.stringify(saveData);
  await pool.execute(
    `INSERT INTO role_game_saves (role_id, save_data)
     VALUES (:roleId, :saveData)
     ON DUPLICATE KEY UPDATE
       save_data = VALUES(save_data),
       updated_at = CURRENT_TIMESTAMP`,
    { roleId: req.role.id, saveData: payload }
  );

  await pool.execute(
    `UPDATE game_roles
     SET level = :level,
         gold = :gold,
         diamond = :diamond,
         power_score = :powerScore,
         stage_progress = :stageProgress,
         arena_points = :arenaPoints,
         last_login_at = CURRENT_TIMESTAMP
     WHERE id = :roleId`,
    {
      roleId: req.role.id,
      level: Number(saveData.teamLv || 1),
      gold: Number(saveData.gold || 0),
      diamond: Number(saveData.gems || 0),
      powerScore: Number(saveData.stage || 1) * 100 + Number(saveData.rebirth || 0) * 500,
      stageProgress: Number(saveData.stage || 1),
      arenaPoints: Number((((saveData || {}).arena || {}).points) || 0)
    }
  );

  res.json({ message: "SAVE_SYNC_OK", updatedAt: new Date().toISOString() });
});

app.post("/api/auth/logout", authRequired, async (req, res) => {
  await pool.execute("DELETE FROM user_sessions WHERE token = :token", {
    token: req.sessionToken
  });
  res.json({ message: "LOGOUT_OK" });
});

app.get("*", (req, res) => {
  res.sendFile(path.resolve(__dirname, "index.html"));
});

ensureDatabaseReady()
  .then(() => ensureSchemaUpgrades())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`次元乱斗Online 服务已启动: http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("数据库初始化失败:", error);
    process.exit(1);
  });
