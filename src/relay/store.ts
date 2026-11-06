import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Session, Host, RelayEvent, HistoryPage } from '../shared/protocol.js';

export class RelayStore {
  db: DatabaseSync;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'relay.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS hosts(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,host_id TEXT NOT NULL,updated_at INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_recent ON sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id,seq);
      CREATE TABLE IF NOT EXISTS history(session_id TEXT NOT NULL,cursor TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(session_id,cursor));
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,host_id TEXT NOT NULL,request TEXT NOT NULL,result TEXT);`);
  }
  host(host: Host) { this.db.prepare('INSERT OR REPLACE INTO hosts VALUES(?,?)').run(host.id, JSON.stringify(host)); }
  hosts(): Host[] { return this.db.prepare('SELECT json FROM hosts').all().map(r => JSON.parse(String(r.json))); }
  session(session: Session) { this.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)').run(session.id, session.hostId, session.updatedAt, JSON.stringify(session)); }
  sessions(): Session[] { return this.db.prepare('SELECT json FROM sessions ORDER BY updated_at DESC').all().map(r => JSON.parse(String(r.json))); }
  getSession(id: string): Session | undefined { const row = this.db.prepare('SELECT json FROM sessions WHERE id=?').get(id); return row && JSON.parse(String(row.json)); }
  event(event: RelayEvent): number | null {
    const result = this.db.prepare('INSERT OR IGNORE INTO events(id,session_id,json) VALUES(?,?,?)').run(event.id, event.sessionId, JSON.stringify(event));
    return result.changes ? Number(result.lastInsertRowid) : null;
  }
  latestSeq(): number { return Number(this.db.prepare('SELECT coalesce(max(seq),0) AS n FROM events').get()!.n); }
  events(after: number, limit=1000): {seq: number; event: RelayEvent}[] { return this.db.prepare('SELECT seq,json FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit).map(r=>({seq:Number(r.seq),event:JSON.parse(String(r.json))})); }
  sessionEvents(id: string): RelayEvent[] { return this.db.prepare('SELECT json FROM (SELECT seq,json FROM events WHERE session_id=? ORDER BY seq DESC LIMIT 1000) ORDER BY seq').all(id).map(r => JSON.parse(String(r.json))); }
  cache(id: string, cursor: number | undefined, page: HistoryPage) { this.db.prepare('INSERT OR REPLACE INTO history VALUES(?,?,?)').run(id, String(cursor ?? 'latest'), JSON.stringify(page)); }
  cached(id: string, cursor?: number): HistoryPage | undefined { const row=this.db.prepare('SELECT json FROM history WHERE session_id=? AND cursor=?').get(id,String(cursor ?? 'latest')); return row && JSON.parse(String(row.json)); }
  beginAction(id: string, host: string, request: unknown): { fresh: boolean; result?: any } {
    const json = JSON.stringify(request);
    const old = this.db.prepare('SELECT host_id,request,result FROM actions WHERE id=?').get(id);
    if (old) {
      if (old.host_id !== host || old.request !== json) throw new Error('Action ID already used for a different request');
      return {fresh:false,result:old.result ? JSON.parse(String(old.result)) : undefined};
    }
    this.db.prepare('INSERT INTO actions VALUES(?,?,?,NULL)').run(id,host,json);
    return {fresh:true};
  }
  finishAction(id: string, result: unknown) { this.db.prepare('UPDATE actions SET result=? WHERE id=?').run(JSON.stringify(result),id); }
  close() { this.db.close(); }
}
