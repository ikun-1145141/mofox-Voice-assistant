import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { ServerEvent } from '@mofox/protocol';

export interface Turn { id: string; submissionId: string; cancelled: boolean; coreFinished: boolean; pendingSynthesis: number; pendingPlayback: Set<string>; abort: AbortController; timeout: ReturnType<typeof setTimeout> | null }
export interface Session {
  id: string; clientId: string; admin: boolean; tokenHash: string;
  turn: Turn | null; seen: Set<string>; send: (event: ServerEvent) => void;
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export function equalSecret(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}
export class SessionStore {
  private sessions = new Map<string, Session>();
  private saving: Promise<void> = Promise.resolve();
  constructor(private dataRoot: string) {}
  async load(): Promise<void> {
    try {
      const rows: { id: string; clientId: string; admin: boolean; tokenHash: string }[] = JSON.parse(await readFile(path.join(this.dataRoot, 'sessions.json'), 'utf8'));
      for (const row of rows) if (typeof row.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(row.tokenHash)) this.sessions.set(row.tokenHash, { ...row, turn: null, seen: new Set(), send: () => {} });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  get(token?: string): Session | undefined { return token ? this.sessions.get(hash(token)) : undefined; }
  all(): IterableIterator<Session> { return this.sessions.values(); }
  async create(admin: boolean): Promise<{ token: string; session: Session }> {
    if (this.sessions.size >= 100) throw new Error('已达到配对设备上限');
    const token = randomBytes(32).toString('hex');
    const session: Session = { id: randomUUID(), clientId: randomUUID(), admin, tokenHash: hash(token), turn: null, seen: new Set(), send: () => {} };
    this.sessions.set(session.tokenHash, session);
    await this.persist();
    return { token, session };
  }
  async renew(session: Session): Promise<void> { if (session.turn?.timeout) clearTimeout(session.turn.timeout); session.id = randomUUID(); session.turn = null; session.seen.clear(); await this.persist(); }
  private persist(): Promise<void> {
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(this.dataRoot, { recursive: true });
      const rows = [...this.sessions.values()].map(({ id, clientId, admin, tokenHash }) => ({ id, clientId, admin, tokenHash }));
      const target = path.join(this.dataRoot, 'sessions.json');
      await writeFile(`${target}.tmp`, `${JSON.stringify(rows)}\n`, { mode: 0o600 });
      await rename(`${target}.tmp`, target);
    });
    return this.saving;
  }
}
