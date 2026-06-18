# CMR Unit Cost Manager

Node.js app for managing material price lists and unit cost assemblies.

## Install & Run

```bash
npm install
node server.js
```

Opens on http://localhost:3077 (or whatever IP your Pi is on).

## Features

- **Materials** — Master list of all materials by CSI division with full price history
- **Unit Costs** — Named assemblies (e.g. "8" CMU Wall $/SF") with material + labor tables
- **Calc Scratch Pad** — Per-unit scratch area for quantity derivations; define named variables, reference them in qty fields with `=varname`
- **Stale Price Detection** — When master material prices update, open unit costs flag which lines are stale with a refresh prompt
- **Publications** — Publish a unit cost with project name, estimator, date, and $/unit snapshot; full history tracked
- **Backup Files** — Upload PDF price sheets and link them to one or many materials

## Data

- SQLite database stored at `data/unitcosts.db`
- PDF uploads stored in `uploads/`
- Auto-seeds from your existing Excel materials on first run

## Port

Change `PORT` at the top of `server.js` if 3077 conflicts with other tools.
