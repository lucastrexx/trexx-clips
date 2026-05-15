import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export function createDb(databasePath) {
  const dir = path.dirname(databasePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      payout_per_milestone_stroops TEXT NOT NULL,
      sponsor_pubkey TEXT,
      escrow_funded INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS clips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      platform TEXT NOT NULL,
      creator_pubkey TEXT NOT NULL,
      views INTEGER DEFAULT 0,
      milestones_paid INTEGER DEFAULT 0,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    );
  `);
  return db;
}

export function campaignQueries(db) {
  return {
    createCampaign({ title, description, payoutPerMilestoneStroops, sponsorPubkey }) {
      const stmt = db.prepare(
        `INSERT INTO campaigns (title, description, payout_per_milestone_stroops, sponsor_pubkey)
         VALUES (@title, @description, @payoutPerMilestoneStroops, @sponsorPubkey)`,
      );
      const r = stmt.run({ title, description: description ?? '', payoutPerMilestoneStroops, sponsorPubkey: sponsorPubkey ?? null });
      return r.lastInsertRowid;
    },
    listCampaigns() {
      return db.prepare(`SELECT * FROM campaigns ORDER BY id DESC`).all();
    },
    getCampaign(id) {
      return db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id);
    },
    markFunded(id) {
      db.prepare(`UPDATE campaigns SET escrow_funded = 1 WHERE id = ?`).run(id);
    },
    addClip({ campaignId, url, platform, creatorPubkey }) {
      const stmt = db.prepare(
        `INSERT INTO clips (campaign_id, url, platform, creator_pubkey) VALUES (?, ?, ?, ?)`,
      );
      const r = stmt.run(campaignId, url, platform, creatorPubkey);
      return r.lastInsertRowid;
    },
    listClips(campaignId) {
      return db.prepare(`SELECT * FROM clips WHERE campaign_id = ? ORDER BY id`).all(campaignId);
    },
    updateClipViews(clipId, views) {
      db.prepare(`UPDATE clips SET views = ? WHERE id = ?`).run(views, clipId);
    },
    clipsForSettle(campaignId) {
      return db.prepare(`SELECT * FROM clips WHERE campaign_id = ?`).all(campaignId);
    },
    addMilestonesPaid(clipId, delta) {
      db.prepare(`UPDATE clips SET milestones_paid = milestones_paid + ? WHERE id = ?`).run(delta, clipId);
    },
  };
}
