import type * as Party from 'partykit/server';

const HEARTBEAT_TTL_MS = 90_000;
const STORAGE_KEY = 'gamesCompleted';

const ALLOWED_FETCH_ORIGINS: RegExp[] = [
  /^https:\/\/dotsandboxes\.aeonic\.earth$/,
  /^https:\/\/[a-z0-9.-]+\.vercel\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

export default class Stats implements Party.Server {
  gamesCompleted = 0;
  activeRooms = new Map<string, number>(); // roomId -> last heartbeat ts

  constructor(readonly room: Party.Room) {}

  async onStart() {
    const stored = await this.room.storage.get<number>(STORAGE_KEY);
    if (typeof stored === 'number') this.gamesCompleted = stored;
  }

  async onRequest(req: Party.Request): Promise<Response> {
    const origin = req.headers.get('origin') || '';
    const corsOrigin = ALLOWED_FETCH_ORIGINS.some(p => p.test(origin)) ? origin : '';
    const corsHeaders: Record<string, string> = {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    };
    if (corsOrigin) corsHeaders['access-control-allow-origin'] = corsOrigin;

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method === 'GET') {
      this.gcStale();
      return new Response(
        JSON.stringify({
          gamesCompleted: this.gamesCompleted,
          gamesInProgress: this.activeRooms.size,
        }),
        { headers: { ...corsHeaders, 'content-type': 'application/json' } },
      );
    }

    if (req.method === 'POST') {
      let body: any;
      try { body = await req.json(); } catch { return new Response('bad request', { status: 400 }); }
      if (body?.type === 'heartbeat' && typeof body.roomId === 'string') {
        this.activeRooms.set(body.roomId, Date.now());
      } else if (body?.type === 'game_ended' && typeof body.roomId === 'string') {
        this.activeRooms.delete(body.roomId);
        this.gamesCompleted++;
        await this.room.storage.put(STORAGE_KEY, this.gamesCompleted);
      }
      this.gcStale();
      return new Response('ok', { headers: corsHeaders });
    }

    return new Response('method not allowed', { status: 405, headers: corsHeaders });
  }

  private gcStale() {
    const cutoff = Date.now() - HEARTBEAT_TTL_MS;
    for (const [room, t] of this.activeRooms) {
      if (t < cutoff) this.activeRooms.delete(room);
    }
  }
}
