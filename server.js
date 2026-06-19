const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getDb, query, run } = require('./database');

const app = express();
const PORT = 3077;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, fileFilter: (req, file, cb) => {
  if (file.mimetype === 'application/pdf') cb(null, true);
  else cb(new Error('Only PDF files allowed'));
}});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── MATERIALS ───────────────────────────────────────────────────────────────

app.get('/api/materials', async (req, res) => {
  await getDb();
  const { division } = req.query;
  let sql = 'SELECT * FROM materials ORDER BY division, item_name';
  let params = [];
  if (division) { sql = 'SELECT * FROM materials WHERE division = ? ORDER BY item_name'; params = [division]; }
  res.json(query(sql, params));
});

app.get('/api/materials/:id', async (req, res) => {
  await getDb();
  const rows = query('SELECT * FROM materials WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const mat = rows[0];
  mat.history = query('SELECT * FROM material_price_history WHERE material_id = ? ORDER BY changed_at DESC', [mat.id]);
  mat.backup_files = query(`
    SELECT pbf.* FROM price_backup_files pbf
    JOIN material_backup_links mbl ON mbl.backup_file_id = pbf.id
    WHERE mbl.material_id = ?`, [mat.id]);
  res.json(mat);
});

app.post('/api/materials', async (req, res) => {
  await getDb();
  const { division, item_name, purchase_unit, cost_per_unit, date_updated, updated_by, comments } = req.body;
  const result = run(
    `INSERT INTO materials (division, item_name, purchase_unit, cost_per_unit, date_updated, updated_by, comments)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [division, item_name, purchase_unit, cost_per_unit, date_updated, updated_by, comments || null]
  );
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/materials/:id', async (req, res) => {
  await getDb();
  const id = req.params.id;
  const existing = query('SELECT * FROM materials WHERE id = ?', [id]);
  if (!existing.length) return res.status(404).json({ error: 'Not found' });

  const old = existing[0];
  const { division, item_name, purchase_unit, cost_per_unit, date_updated, updated_by, comments } = req.body;

  // Archive old price to history
  run(
    `INSERT INTO material_price_history (material_id, cost_per_unit, date_updated, updated_by, comments)
     VALUES (?, ?, ?, ?, ?)`,
    [id, old.cost_per_unit, old.date_updated, old.updated_by, old.comments || null]
  );

  run(
    `UPDATE materials SET division=?, item_name=?, purchase_unit=?, cost_per_unit=?,
     date_updated=?, updated_by=?, comments=? WHERE id=?`,
    [division, item_name, purchase_unit, cost_per_unit, date_updated, updated_by, comments || null, id]
  );
  res.json({ success: true });
});

app.delete('/api/materials/:id', async (req, res) => {
  await getDb();
  run('DELETE FROM material_backup_links WHERE material_id = ?', [req.params.id]);
  run('DELETE FROM material_price_history WHERE material_id = ?', [req.params.id]);
  run('DELETE FROM materials WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// Edit a single price-history entry (to correct a mistaken archived price)
app.put('/api/materials/:id/history/:histId', async (req, res) => {
  await getDb();
  const { id, histId } = req.params;
  const existing = query('SELECT * FROM material_price_history WHERE id = ? AND material_id = ?', [histId, id]);
  if (!existing.length) return res.status(404).json({ error: 'Not found' });
  const { cost_per_unit, date_updated, updated_by, comments } = req.body;
  run(
    `UPDATE material_price_history SET cost_per_unit=?, date_updated=?, updated_by=?, comments=? WHERE id=?`,
    [cost_per_unit, date_updated, updated_by, comments || null, histId]
  );
  res.json({ success: true });
});

// Delete a single price-history entry
app.delete('/api/materials/:id/history/:histId', async (req, res) => {
  await getDb();
  const { id, histId } = req.params;
  run('DELETE FROM material_price_history WHERE id = ? AND material_id = ?', [histId, id]);
  res.json({ success: true });
});

// Link backup file to material
app.post('/api/materials/:id/backup-links', async (req, res) => {
  await getDb();
  const { backup_file_id } = req.body;
  run('INSERT OR IGNORE INTO material_backup_links (material_id, backup_file_id) VALUES (?, ?)',
    [req.params.id, backup_file_id]);
  res.json({ success: true });
});

app.delete('/api/materials/:id/backup-links/:fileId', async (req, res) => {
  await getDb();
  run('DELETE FROM material_backup_links WHERE material_id = ? AND backup_file_id = ?',
    [req.params.id, req.params.fileId]);
  res.json({ success: true });
});

// ─── BACKUP FILES ─────────────────────────────────────────────────────────────

app.get('/api/backup-files', async (req, res) => {
  await getDb();
  res.json(query('SELECT * FROM price_backup_files ORDER BY upload_date DESC'));
});

app.post('/api/backup-files', upload.single('pdf'), async (req, res) => {
  await getDb();
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  const { uploaded_by, description } = req.body;
  const result = run(
    `INSERT INTO price_backup_files (filename, original_name, uploaded_by, description)
     VALUES (?, ?, ?, ?)`,
    [req.file.filename, req.file.originalname, uploaded_by || null, description || null]
  );
  res.json({ id: result.lastInsertRowid, filename: req.file.filename });
});

app.delete('/api/backup-files/:id', async (req, res) => {
  await getDb();
  const rows = query('SELECT * FROM price_backup_files WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(UPLOADS_DIR, rows[0].filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  run('DELETE FROM material_backup_links WHERE backup_file_id = ?', [req.params.id]);
  run('DELETE FROM price_backup_files WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ─── UNIT COSTS ───────────────────────────────────────────────────────────────

app.get('/api/unit-costs', async (req, res) => {
  await getDb();
  const { division } = req.query;
  const cols = `uc.*,
    (SELECT cost_per_unit FROM unit_cost_publications WHERE unit_cost_id = uc.id ORDER BY published_at DESC LIMIT 1) as last_published_cost,
    (SELECT published_at FROM unit_cost_publications WHERE unit_cost_id = uc.id ORDER BY published_at DESC LIMIT 1) as last_published_at,
    (SELECT COUNT(*) FROM unit_cost_material_lines ucml JOIN materials m ON m.id = ucml.material_id
      WHERE ucml.unit_cost_id = uc.id AND ucml.price_snapshot IS NOT NULL AND ucml.price_snapshot <> m.cost_per_unit) as stale_count`;
  let sql = `SELECT ${cols} FROM unit_costs uc ORDER BY uc.division, uc.name`;
  let params = [];
  if (division) {
    sql = `SELECT ${cols} FROM unit_costs uc WHERE uc.division = ? ORDER BY uc.name`;
    params = [division];
  }
  res.json(query(sql, params));
});

app.get('/api/unit-costs/:id', async (req, res) => {
  await getDb();
  const rows = query('SELECT * FROM unit_costs WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const uc = rows[0];

  uc.material_lines = query(
    `SELECT ucml.*, m.item_name as master_name, m.cost_per_unit as current_price, m.purchase_unit as master_unit
     FROM unit_cost_material_lines ucml
     LEFT JOIN materials m ON m.id = ucml.material_id
     WHERE ucml.unit_cost_id = ? ORDER BY ucml.line_order`,
    [uc.id]
  );

  uc.labor_lines = query(
    'SELECT * FROM unit_cost_labor_lines WHERE unit_cost_id = ? ORDER BY line_order',
    [uc.id]
  );

  uc.publications = query(
    'SELECT * FROM unit_cost_publications WHERE unit_cost_id = ? ORDER BY published_at DESC',
    [uc.id]
  );

  // Flag stale materials
  uc.stale_count = uc.material_lines.filter(
    l => l.material_id && l.current_price !== null && l.price_snapshot !== l.current_price
  ).length;

  res.json(uc);
});

app.post('/api/unit-costs', async (req, res) => {
  await getDb();
  const { name, division, output_unit, created_by, misc_bond_pct, escalation_pct, markup_pct, calc_scratch, comments, output_quantity } = req.body;
  const result = run(
    `INSERT INTO unit_costs (name, division, output_unit, created_by, misc_bond_pct, escalation_pct, markup_pct, calc_scratch, comments, output_quantity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, division, output_unit, created_by,
     misc_bond_pct ?? 5, escalation_pct ?? 3, markup_pct ?? 15,
     calc_scratch || null, comments || null, output_quantity || null]
  );
  const id = result.lastInsertRowid;

  // Insert default empty lines (waste multiplier defaults to 1.1)
  for (let i = 0; i < 14; i++) {
    run('INSERT INTO unit_cost_material_lines (unit_cost_id, line_order, multiplier) VALUES (?, ?, 1.1)', [id, i + 1]);
  }
  for (let i = 0; i < 8; i++) {
    run('INSERT INTO unit_cost_labor_lines (unit_cost_id, line_order) VALUES (?, ?)', [id, i + 1]);
  }

  res.json({ id });
});

app.put('/api/unit-costs/:id', async (req, res) => {
  await getDb();
  const { name, division, output_unit, misc_bond_pct, escalation_pct, markup_pct, calc_scratch, comments, output_quantity } = req.body;
  run(
    `UPDATE unit_costs SET name=?, division=?, output_unit=?, misc_bond_pct=?, escalation_pct=?,
     markup_pct=?, calc_scratch=?, comments=?, output_quantity=?, updated_at=datetime('now') WHERE id=?`,
    [name, division, output_unit, misc_bond_pct || 0, escalation_pct || 0, markup_pct || 0, calc_scratch || null, comments || null, output_quantity || null, req.params.id]
  );
  res.json({ success: true });
});

app.delete('/api/unit-costs/:id', async (req, res) => {
  await getDb();
  const id = req.params.id;
  run('DELETE FROM unit_cost_material_lines WHERE unit_cost_id = ?', [id]);
  run('DELETE FROM unit_cost_labor_lines WHERE unit_cost_id = ?', [id]);
  run('DELETE FROM unit_cost_publications WHERE unit_cost_id = ?', [id]);
  run('DELETE FROM unit_costs WHERE id = ?', [id]);
  res.json({ success: true });
});

// Save material lines
app.put('/api/unit-costs/:id/material-lines', async (req, res) => {
  await getDb();
  const id = req.params.id;
  const { lines } = req.body;

  run('DELETE FROM unit_cost_material_lines WHERE unit_cost_id = ?', [id]);
  for (const line of lines) {
    run(
      `INSERT INTO unit_cost_material_lines
       (unit_cost_id, line_order, material_id, description, purchase_unit, price_per_unit, price_snapshot, multiplier, quantity_formula, quantity, extended)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, line.line_order, line.material_id || null, line.description || null,
       line.purchase_unit || null, line.price_per_unit || 0, line.price_snapshot || null,
       line.multiplier || 1, line.quantity_formula || null, line.quantity || 0, line.extended || 0]
    );
  }
  // A content change means the published snapshot is now out of date
  run(`UPDATE unit_costs SET updated_at=datetime('now'), status='draft' WHERE id=?`, [id]);
  res.json({ success: true });
});

// Save labor lines
app.put('/api/unit-costs/:id/labor-lines', async (req, res) => {
  await getDb();
  const id = req.params.id;
  const { lines } = req.body;

  run('DELETE FROM unit_cost_labor_lines WHERE unit_cost_id = ?', [id]);
  for (const line of lines) {
    run(
      `INSERT INTO unit_cost_labor_lines
       (unit_cost_id, line_order, labor_type, crew_size, hours, hours_total, labor_rate, extended)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, line.line_order, line.labor_type || null,
       line.crew_size || 0, line.hours || 0, line.hours_total || 0,
       line.labor_rate || 0, line.extended || 0]
    );
  }
  res.json({ success: true });
});

// Refresh stale material prices
app.post('/api/unit-costs/:id/refresh-prices', async (req, res) => {
  await getDb();
  const id = req.params.id;
  const lines = query(
    'SELECT * FROM unit_cost_material_lines WHERE unit_cost_id = ? AND material_id IS NOT NULL',
    [id]
  );
  let updated = 0;
  for (const line of lines) {
    const mat = query('SELECT cost_per_unit FROM materials WHERE id = ?', [line.material_id]);
    if (mat.length && mat[0].cost_per_unit !== line.price_snapshot) {
      run(
        'UPDATE unit_cost_material_lines SET price_per_unit=?, price_snapshot=? WHERE id=?',
        [mat[0].cost_per_unit, mat[0].cost_per_unit, line.id]
      );
      updated++;
    }
  }
  run(`UPDATE unit_costs SET updated_at=datetime('now'), status='draft' WHERE id=?`, [id]);
  res.json({ updated });
});

// Publish unit cost
app.post('/api/unit-costs/:id/publish', async (req, res) => {
  await getDb();
  const { project_name, estimator, cost_per_unit, notes } = req.body;
  const uc = query('SELECT * FROM unit_costs WHERE id = ?', [req.params.id]);
  if (!uc.length) return res.status(404).json({ error: 'Not found' });

  // Build snapshot
  const matLines = query('SELECT * FROM unit_cost_material_lines WHERE unit_cost_id = ?', [req.params.id]);
  const labLines = query('SELECT * FROM unit_cost_labor_lines WHERE unit_cost_id = ?', [req.params.id]);
  const snapshot = JSON.stringify({ unit_cost: uc[0], material_lines: matLines, labor_lines: labLines });

  run(
    `INSERT INTO unit_cost_publications (unit_cost_id, project_name, estimator, cost_per_unit, output_unit, snapshot_json, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [req.params.id, project_name || null, estimator, cost_per_unit, uc[0].output_unit, snapshot, notes || null]
  );

  run(`UPDATE unit_costs SET status='published', updated_at=datetime('now') WHERE id=?`, [req.params.id]);
  res.json({ success: true });
});

app.get('/api/unit-costs/:id/publications', async (req, res) => {
  await getDb();
  res.json(query(
    'SELECT * FROM unit_cost_publications WHERE unit_cost_id = ? ORDER BY published_at DESC',
    [req.params.id]
  ));
});

// Edit a publication entry (e.g. amend notes without re-publishing)
app.put('/api/unit-costs/:id/publications/:pubId', async (req, res) => {
  await getDb();
  const { id, pubId } = req.params;
  const existing = query('SELECT * FROM unit_cost_publications WHERE id = ? AND unit_cost_id = ?', [pubId, id]);
  if (!existing.length) return res.status(404).json({ error: 'Not found' });
  const { project_name, estimator, cost_per_unit, notes } = req.body;
  run(
    `UPDATE unit_cost_publications SET project_name=?, estimator=?, cost_per_unit=?, notes=? WHERE id=?`,
    [project_name || null, estimator, cost_per_unit, notes || null, pubId]
  );
  res.json({ success: true });
});

// Delete a publication entry
app.delete('/api/unit-costs/:id/publications/:pubId', async (req, res) => {
  await getDb();
  const { id, pubId } = req.params;
  run('DELETE FROM unit_cost_publications WHERE id = ? AND unit_cost_id = ?', [pubId, id]);
  res.json({ success: true });
});


// ─── DIVISIONS LIST ───────────────────────────────────────────────────────────

app.get('/api/divisions', (req, res) => {
  res.json([
    { num: 2, label: '02 - Existing Conditions' },
    { num: 3, label: '03 - Concrete' },
    { num: 4, label: '04 - Masonry' },
    { num: 5, label: '05 - Metals' },
    { num: 6, label: '06 - Carpentry' },
    { num: 7, label: '07 - Envelope' },
    { num: 8, label: '08 - Openings' },
    { num: 9, label: '09 - Finishes' },
    { num: 11, label: '11 - Equipment' },
    { num: 14, label: '14 - Conveying' },
    { num: 21, label: '21 - Fire Suppression' },
    { num: 22, label: '22 - Plumbing' },
    { num: 23, label: '23 - Mechanical' },
    { num: 26, label: '26 - Electrical' },
    { num: 27, label: '27 - Technology' },
    { num: 31, label: '31 - Earthwork' },
    { num: 32, label: '32 - Exterior Improvements' },
    { num: 33, label: '33 - Utilities' }
  ]);
});

// ─── SEED FROM EXCEL DATA ────────────────────────────────────────────────────

app.post('/api/seed', async (req, res) => {
  await getDb();
  const existing = query('SELECT COUNT(*) as cnt FROM materials')[0];
  if (existing.cnt > 0) return res.json({ message: 'Already seeded' });

  const EXCEL_DATE_OFFSET = 25569;
  function excelDateToISO(serial) {
    if (!serial || isNaN(serial)) return new Date().toISOString().split('T')[0];
    const date = new Date((serial - EXCEL_DATE_OFFSET) * 86400 * 1000);
    return date.toISOString().split('T')[0];
  }

  const materials = [
    [9,'1.5" Z-Furing 20ga','LF',0.64,45470,'JK',''],
    [7,'2.5" XCI Foil-Faced Insulation','SF',1.96,45470,'JK',''],
    [7,'BarriBond HP Liquid Flashing','CTN',325,45470,'JK',''],
    [7,'Hardie Lap Siding (Dreams Collection)','SF',5.62,45470,'JK',''],
    [6,'6x6x10 Treated Wood Post','EA',34.19,45470,'JK',''],
    [6,'1x6-16\' Cedar Fence Plank','LF',2.22,45470,'JK',''],
    [6,'2x6x16 Rough Sawn Cedar','EA',6.25,45470,'JK',''],
    [3,'Footing Concrete 3000 PSI','CY',162,45558,'JK',''],
    [3,'Slab Concrete 4000 PSI','CY',175,45558,'JK',''],
    [3,'Exterior Concrete 4000 PSI','CY',180,45558,'JK',''],
    [3,'Exterior Concrete 4500 PSI','CY',185,45558,'JK',''],
    [32,'ODOT 304 Limestone','Ton',21.5,45538,'JK',''],
    [32,'Terratex Non-Woven Fabric','Roll',594,45538,'JK',''],
    [6,'2x4 Pressure Treated','LF',0.63,45553,'JK',''],
    [6,'2x6 Pressure Treated','LF',0.81,45553,'JK',''],
    [6,'2x8 Pressure Treated','LF',1.14,45553,'JK',''],
    [6,'2x10 Pressure Treated','LF',1.79,45553,'JK',''],
    [6,'2x12 Pressure Treated','LF',2.26,45553,'JK',''],
    [6,'4x8 3/4 Plywood Pressure Treated','SF',1.34,45553,'JK',''],
    [6,'2x4 Fire-Treated','LF',0.94,45553,'JK',''],
    [6,'2x6 Fire-Treated','LF',1.39,45553,'JK',''],
    [6,'2x8 Fire-Treated','LF',1.79,45553,'JK',''],
    [6,'2x10 Fire-Treated','LF',2.49,45553,'JK',''],
    [6,'2x12 Fire-Treated','LF',3.29,45553,'JK',''],
    [6,'4x8 3/4 Plywood Fire Treated','SF',1.73,45553,'JK',''],
    [6,'Construction Screws','Box',44.98,45553,'JK',''],
    [3,'Rebar','Ton',1200,45558,'JK','Based on Feedback from Whitacre'],
    [3,'Rebar Support Chair','EA',50,null,'JK',''],
    [3,'6x6 w1.4 Welded Wire Mesh 8\'x20\'','EA',66.79,45560,'JK','Price from White Cap website per 8\'x20\' sheet'],
    [3,'Stego Wrap Vapor Retarder Class A 10 Mil 14\'x210\'','Roll',501.19,45560,'JK','Price from White Cap website per roll'],
    [3,'Viper II Underslab Vapor Barrier Class A 10 Mil 14\'x210\'','Roll',441.61,45560,'JK','.15/sf'],
    [3,'Viper II Underslab Vapor Barrier Class A 15 Mil 14\'x140\'','Roll',441.61,45560,'JK','.23/sf'],
    [3,'Viper Vapor Tape 4" x 180\'','Roll',44.93,45560,'JK',''],
    [3,'Stego Vapor Barrier Tape 4" x 180\'','Roll',49.99,45560,'JK','White Cap'],
    [3,'3" Grip Rite Slab Bolster (wire-mesh slab support)','LF',1.99,45560,'JK','White Cap'],
    [3,'2" Slab Bolster (wire-mesh slab support)','LF',1.40,45560,'JK','White Cap'],
    [32,'ODOT 57 Lime Stone','Ton',37.65,45560,'JK','Based on DiPietro CO Backup from Crestview'],
    [3,'Expansion Board Slab Isolation','LF',1.85,45560,'JK','White Cap Product'],
    [4,'8x8x16 CMU (Normal Weight)','EA',2.10,45560,'JK','Schory'],
    [4,'12x8x16 CMU (Normal Weight)','EA',3.05,45560,'JK',''],
    [4,'9ga Ladder Mesh','LF',0.12,45560,'JK',''],
    [4,'Hohmann & Barnard Rebar Positioner','EA',0.98,45560,'JK',''],
    [4,'Hohmann & Barnard 270 Ladder & Eye Hook','LF',1.39,45560,'JK',''],
    [4,'12x8x16 Hollow Bond Beam','EA',4.16,45560,'JK',''],
    [4,'Masonry Mortar ASTM C270 Type S','EA',15.85,45560,'JK',''],
    [4,'8oz Acme Water Repelant (1 Bottle per 2 Bags Mortar)','EA',9.50,45560,'JK',''],
    [4,'W/M Sand (per ton)','EA',39.75,45560,'JK',''],
    [4,'Modular Brick','EA',0.80,45561,'JK',''],
    [4,'Jumbo Brick','EA',1.05,45561,'JK',''],
    [4,'Utility Brick','EA',1.70,45561,'JK',''],
    [4,'8x8x16 Hollow Bond Beam','EA',2.99,45561,'JK',''],
    [4,'8x8x16 Bond Beam','EA',3.33,45561,'JK',''],
    [4,'4x8x16 CMU','EA',1.47,45561,'JK',''],
    [4,'6x8x16 CMU','EA',1.98,45561,'JK',''],
    [4,'Hohmann & Barnard Eye Hook (Brick Tie)','EA',0.74,45561,'JK',''],
    [4,'Hohmann & Barnard Neoprene Closed-Cell Compressible Filler','LF',0.85,45562,'JK','Whitecap'],
    [4,'Mortar Net','LF',3.19,45562,'JK','Whitecap'],
    [4,'Hohmann & Barnard Quadro Vent (weeps)','EA',0.60,45562,'JK','Whitecap'],
    [4,'Hohmann & Barnard Mighty-Flash 60\'x18" (Stainless Steel Fabric Flashing)','SF',3.49,45562,'JK','Whitecap'],
    [4,'Hohmann & Barnard T1 SS Termination Bar','LF',3.62,45562,'JK','Whitecap'],
    [4,'Hohmann & Barnard Stainless Steel Flashing Drip Plate','LF',1.51,45562,'JK','Whitecap'],
    [4,'Masonry Mortar ASTM C270 Type N','EA',15.70,45562,'JK','Schory'],
    [4,'Backer Rod','LF',0.10,45562,'JK',''],
    [4,'Hohmann & Barnard End Dam Corners (Inside Or Out)','EA',21.99,45562,'JK','Whitecap'],
    [4,'Pecora Dynatrol I-XL Hybrid 20oz Sausage (caulk)','EA',11.02,45562,'JK',''],
    [33,'30" HDPE Storm Piping - N12 Dual Wall Solid 20\'','LF',33.95,45610,'JK','Core & Main'],
    [33,'24" HDPE Storm Piping - N12 Dual Wall Solid 20\'','LF',24.80,45610,'JK','Core & Main'],
    [33,'18" HDPE Storm Piping - N12 Dual Wall Solid 20\'','LF',14.55,45610,'JK','Core & Main'],
    [33,'15" HDPE Storm Piping - N12 Dual Wall Solid 20\'','LF',11.55,45610,'JK','Core & Main'],
    [33,'12" PVC SDR35 SWR Pipe 14\'','LF',21.30,45610,'JK','Core & Main'],
    [33,'6" PVC Sanitary Piping SDR35 SWR 14\'','LF',5.50,45610,'JK','Core & Main'],
    [33,'6" PVC Sanitary WYE - SDR35','EA',56.65,45610,'JK','Core & Main'],
    [33,'6" PVC Sanitary 45 Elbow - SDR35','EA',25.75,45610,'JK','Core & Main'],
    [33,'6" PVC Sanitary 22.5 Elbow - SDR35','EA',29.00,45610,'JK','Core & Main'],
    [33,'6" PVC Sanitary Cap - SDR35','EA',17.35,45610,'JK','Core & Main'],
    [9,'Nichiha Architectural Block Fiber Cement Board','SF',14.00,45695,'JK','FBM - Gabe Dockery'],
    [7,'3" Cavity Mate Ultra 25PSI Polystyrene 15-3/4"x96"','SF',3.67,45733,'JK','Whitecap'],
    [7,'2.5" Cavity Mate Ultra 25PSI Polystyrene 15-3/4"x96"','SF',3.25,45733,'JK','Whitecap'],
    [7,'2.18" Cavity Mate Ultra 25PSI Polystyrene 15-3/4"x96"','SF',2.81,45733,'JK','Whitecap'],
    [7,'24 OZ Great Stuff Pro Gaps & Cracks Foam','EA',14.99,45733,'JK','Whitecap'],
    [7,'20 OZ Sausage Liquidarmor LT Flashing & Sealant','EA',19.99,45733,'JK','Whitecap'],
    [7,'12" x 75\' Duragard CM Transition Flashing','Roll',175.00,45733,'JK','Whitecap'],
    [7,'2" Thermax Xarmor CI Polyisocyanurate - 4 mil facer','SF',3.84,45733,'JK','Whitecap'],
    [7,'2" Thermax Xarmor CI Polyisocyanurate - 1 mil facer','SF',2.34,45733,'JK','Whitecap'],
    [5,'1.5" BA Acoustical Decking 22ga','SF',2.50,46086,'JK','Vulcraft - Sidney Flory'],
    [5,'1.5" BA Acoustical Decking 20ga','SF',3.25,46086,'JK','Vulcraft - Sidney Flory'],
    [5,'1.5" BA Cellular Acoustical Decking 20ga','SF',14.00,46086,'JK','Vulcraft - Sidney Flory'],
    [5,'1.5" BA Cellular Acoustical Decking 18ga','SF',19.00,46086,'JK','Vulcraft - Sidney Flory'],
    [5,'3" Acoustical Decking 22ga','SF',3.00,46086,'JK','Vulcraft - Sidney Flory'],
    [5,'3" Acoustical Decking 20ga','SF',5.00,46086,'JK','Vulcraft - Sidney Flory'],
    [5,'3" Cellular Acoustical Decking 20ga','SF',16.00,46086,'JK','Vulcraft - Sidney Flory'],
    [5,'3" Cellular Acoustical Decking 18ga','SF',21.00,46086,'JK','Vulcraft - Sidney Flory'],
  ];

  for (const [div, name, unit, cost, dateSerial, by, comments] of materials) {
    run(
      `INSERT INTO materials (division, item_name, purchase_unit, cost_per_unit, date_updated, updated_by, comments)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [div, name, unit, cost, excelDateToISO(dateSerial), by, comments]
    );
  }

  res.json({ seeded: materials.length });
});

app.listen(PORT, () => {
  console.log(`CMR Unit Cost Server running on http://localhost:${PORT}`);
});
