const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'unitcosts.db');

let db = null;

async function getDb() {
  if (db) return db;

  if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  }

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  initSchema(db);
  saveDb();
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function initSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      division INTEGER NOT NULL,
      item_name TEXT NOT NULL,
      purchase_unit TEXT NOT NULL,
      cost_per_unit REAL NOT NULL,
      date_updated TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      comments TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS material_price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL,
      cost_per_unit REAL NOT NULL,
      date_updated TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      comments TEXT,
      changed_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (material_id) REFERENCES materials(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS price_backup_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      upload_date TEXT DEFAULT (datetime('now')),
      uploaded_by TEXT,
      description TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS material_backup_links (
      material_id INTEGER NOT NULL,
      backup_file_id INTEGER NOT NULL,
      PRIMARY KEY (material_id, backup_file_id),
      FOREIGN KEY (material_id) REFERENCES materials(id),
      FOREIGN KEY (backup_file_id) REFERENCES price_backup_files(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS unit_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      division INTEGER NOT NULL,
      output_unit TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      misc_bond_pct REAL DEFAULT 5,
      escalation_pct REAL DEFAULT 3,
      markup_pct REAL DEFAULT 15,
      calc_scratch TEXT,
      comments TEXT,
      status TEXT DEFAULT 'draft'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS unit_cost_material_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_cost_id INTEGER NOT NULL,
      line_order INTEGER NOT NULL,
      material_id INTEGER,
      description TEXT,
      purchase_unit TEXT,
      price_per_unit REAL,
      price_snapshot REAL,
      multiplier REAL DEFAULT 1,
      quantity_formula TEXT,
      quantity REAL DEFAULT 0,
      extended REAL DEFAULT 0,
      FOREIGN KEY (unit_cost_id) REFERENCES unit_costs(id),
      FOREIGN KEY (material_id) REFERENCES materials(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS unit_cost_labor_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_cost_id INTEGER NOT NULL,
      line_order INTEGER NOT NULL,
      labor_type TEXT,
      crew_size REAL DEFAULT 0,
      hours REAL DEFAULT 0,
      hours_total REAL DEFAULT 0,
      labor_rate REAL DEFAULT 0,
      extended REAL DEFAULT 0,
      FOREIGN KEY (unit_cost_id) REFERENCES unit_costs(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS unit_cost_publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_cost_id INTEGER NOT NULL,
      project_name TEXT,
      estimator TEXT NOT NULL,
      published_at TEXT DEFAULT (datetime('now')),
      cost_per_unit REAL NOT NULL,
      output_unit TEXT NOT NULL,
      snapshot_json TEXT,
      notes TEXT,
      FOREIGN KEY (unit_cost_id) REFERENCES unit_costs(id)
    )
  `);
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
  return { lastInsertRowid: query('SELECT last_insert_rowid() as id')[0].id };
}

module.exports = { getDb, saveDb, query, run };
