/* Bobi's Valley — server multiplayer (Render + database PostgreSQL su Aiven)
   È il vostro server.js con in più il multiplayer completo del gioco:
   - stanze con codice di 5 cifre (room_name nella tabella game_sessions)
   - isola condivisa: risorse, livelli, costruzioni, Bobi, Bobiville, CandyLand
   - posizioni dei giocatori per vedersi nel mondo
   Gli eventi che avevate già (joinGame, collectBerry, collectWood, collectFlower, addMoney, levelUp, saveScore)
   funzionano come prima.
   Variabili d'ambiente su Render (come prima): DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_NAME
   Il certificato del database resta nel file ca.pem accanto a questo file. */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const caPath = path.join(__dirname, 'ca.pem');
const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'off' ? false : {
        rejectUnauthorized: true,
        ca: fs.existsSync(caPath) ? fs.readFileSync(caPath).toString() : undefined,
    },
});

/* Alla partenza aggiunge alla tabella game_sessions la colonna "state", dove si salva tutta l'isola della stanza.
   Le colonne che avevate (level, money, wood, berries, flowers) restano e vengono tenute aggiornate. */
pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS state JSONB')
    .then(() => console.log('✅ Connesso al database PostgreSQL! (colonna state pronta)'))
    .catch(err => console.error('❌ Errore di connessione al DB:', err.message));

const app = express();
/* il server mostra anche il gioco: aprendo https://bobisvalley-server.onrender.com si gioca direttamente */
const GAME = [path.join(__dirname, 'index.html'), path.join(__dirname, '..', 'index.html')].find(f => fs.existsSync(f));
app.get(['/', '/index.html'], (req, res) => {
    if (!GAME) return res.send('Bobi\'s Valley server online');
    res.set('cache-control', 'no-cache');
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        const st = fs.statSync(GAME);
        if (!app.gz || app.gz.t != +st.mtime) app.gz = { t: +st.mtime, d: require('zlib').gzipSync(fs.readFileSync(GAME), { level: 9 }) };
        res.set({ 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', vary: 'accept-encoding' });
        return res.send(app.gz.d);
    }
    res.sendFile(GAME);
});
app.get('/health', (req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },  // permette al gioco (Netlify) e al sito (GitHub Pages) di connettersi
    maxHttpBufferSize: 4e6,
});

/* ======================= MULTIPLAYER DEL GIOCO ======================= */
const MAX_PLAYERS = 8;
const PATH_RE = /^[a-z]\.[A-Za-z0-9_]{1,40}$/;
const rooms = new Map(); // codice -> { id, code, state, players: Map(socket.id -> giocatore), dirty }
const clean = (s, n) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);

async function dbFind(code) {
    const r = await pool.query('SELECT * FROM game_sessions WHERE room_name = $1 ORDER BY id LIMIT 1', [code]);
    return r.rows[0] || null;
}
async function loadRoom(code) {
    if (rooms.has(code)) return rooms.get(code);
    const row = await dbFind(code);
    if (!row || !row.state) return null;
    if (rooms.has(code)) return rooms.get(code);
    const room = { id: row.id, code, state: row.state, players: new Map(), dirty: false };
    rooms.set(code, room);
    return room;
}
async function createRoom(code, state) {
    if (rooms.has(code)) return null;
    const row = await dbFind(code);
    if (row && row.state) return null; // codice già usato da una stanza del gioco
    let id;
    if (row) { // riga creata dal vecchio evento joinGame: la riusa
        id = row.id;
        await pool.query('UPDATE game_sessions SET state = $2 WHERE id = $1', [id, JSON.stringify(state)]);
    } else {
        const r = await pool.query('INSERT INTO game_sessions (room_name, state) VALUES ($1, $2) RETURNING id', [code, JSON.stringify(state)]);
        id = r.rows[0].id;
    }
    if (rooms.has(code)) return null;
    const room = { id, code, state, players: new Map(), dirty: true };
    rooms.set(code, room);
    return room;
}
/* numeri riassuntivi per le colonne della tabella */
function summary(st) {
    const n = v => Math.round(Number(v) || 0);
    const flw = Array.isArray(st['g.flw']) ? st['g.flw'].reduce((a, b) => a + (Number(b) || 0), 0) : 0;
    return { level: Math.floor(n(st['g.xp']) / 50), money: n(st['g.cash']), wood: n(st['g.pl']), berries: n(st['g.bag']), flowers: n(flw) };
}
async function saveRoom(room) {
    if (!room.dirty) return;
    room.dirty = false;
    const s = summary(room.state);
    try {
        await pool.query('UPDATE game_sessions SET state = $2, level = $3, money = $4, wood = $5, berries = $6, flowers = $7 WHERE id = $1',
            [room.id, JSON.stringify(room.state), s.level, s.money, s.wood, s.berries, s.flowers]);
    } catch (err) {
        room.dirty = true;
        console.error('❌ Salvataggio stanza', room.code, err.message);
    }
}
setInterval(() => {
    for (const room of rooms.values()) {
        saveRoom(room);
        if (!room.players.size && !room.dirty) rooms.delete(room.code);
    }
}, 5000);

/* modifiche inviate dai giocatori: a = somma (numeri), m = massimo, u = unione di liste, s = sostituisci */
const isNumArr = v => Array.isArray(v) && v.every(x => typeof x == 'number');
function applyOps(state, ops) {
    const ok = [];
    for (const o of ops) {
        if (!o || typeof o.p != 'string' || !PATH_RE.test(o.p)) continue;
        const cur = state[o.p];
        if ('a' in o) {
            if (typeof o.a == 'number' && isFinite(o.a)) state[o.p] = (typeof cur == 'number' ? cur : 0) + o.a;
            else if (isNumArr(o.a)) { const b = isNumArr(cur) ? cur.slice() : []; o.a.forEach((v, i) => b[i] = (b[i] || 0) + v); state[o.p] = b; }
            else continue;
        } else if ('m' in o) { if (typeof o.m != 'number') continue; state[o.p] = Math.max(typeof cur == 'number' ? cur : -Infinity, o.m); }
        else if ('u' in o) { if (!Array.isArray(o.u)) continue; const b = Array.isArray(cur) ? cur.slice() : []; o.u.forEach(v => { if (!b.includes(v)) b.push(v); }); state[o.p] = b; }
        else if ('s' in o) { if (o.s === null) delete state[o.p]; else state[o.p] = o.s; }
        else continue;
        ok.push(o);
    }
    return ok;
}

io.on('connection', (socket) => {
    console.log('🎮 Giocatore connesso:', socket.id);
    let me = null; // { id, name, look, pos, room }

    /* entrare o creare una stanza del gioco: risponde con { ok, state, players } oppure { err } */
    async function enter(data, create, reply) {
        if (typeof reply != 'function') return;
        try {
            if (me) return reply({ err: 'Sei già in una stanza.' });
            const code = String((data && data.code) || '');
            if (!/^\d{5}$/.test(code)) return reply({ err: 'Il codice deve avere 5 cifre.' });
            let room;
            if (create) {
                const st = data.state && typeof data.state == 'object' ? data.state : {};
                for (const k of Object.keys(st)) if (!PATH_RE.test(k)) delete st[k];
                room = await createRoom(code, st);
                if (!room) return reply({ err: 'Questo codice è già usato da un\'altra stanza: scegline un altro.' });
            } else {
                room = await loadRoom(code);
                if (!room) return reply({ err: 'Nessuna stanza con questo codice.' });
            }
            if (room.players.size >= MAX_PLAYERS) return reply({ err: 'La stanza è piena (massimo ' + MAX_PLAYERS + ' giocatori).' });
            me = { id: socket.id, name: clean(data.name, 20) || 'Giocatore', look: data.look && typeof data.look == 'object' ? data.look : null, pos: null, room };
            room.players.set(socket.id, me);
            socket.join('mp:' + code);
            reply({ ok: true, code, you: socket.id, state: room.state,
                players: [...room.players.values()].filter(p => p != me).map(p => ({ id: p.id, name: p.name, look: p.look, pos: p.pos })) });
            socket.to('mp:' + code).emit('mpHello', { id: me.id, name: me.name, look: me.look });
            console.log(`🎮 ${me.name} è entrato nella stanza ${code}`);
        } catch (err) {
            console.error(err);
            reply({ err: 'Errore del server, riprova.' });
        }
    }
    socket.on('mpCreate', (data, reply) => enter(data, true, reply));
    socket.on('mpJoin', (data, reply) => enter(data, false, reply));
    socket.on('mpOps', (data, reply) => {
        if (!me || !data || !Array.isArray(data.ops)) return;
        const ok = applyOps(me.room.state, data.ops);
        if (ok.length) { me.room.dirty = true; socket.to('mp:' + me.room.code).emit('mpOps', { from: me.id, ops: ok }); }
        if (typeof reply == 'function') reply({ ok: true });
    });
    socket.on('mpPos', (p) => {
        if (!me || !Array.isArray(p)) return;
        me.pos = p.slice(0, 8);
        socket.volatile.to('mp:' + me.room.code).emit('mpPos', { id: me.id, p: me.pos });
    });
    socket.on('mpLook', (look) => {
        if (!me) return;
        me.look = look;
        socket.to('mp:' + me.room.code).emit('mpLook', { id: me.id, look });
    });

    /* ======================= EVENTI CHE AVEVATE GIÀ ======================= */
    // 1. Quando un giocatore si connette a una stanza multiplayer
    socket.on('joinGame', (data) => {
        const roomName = data.room;
        socket.join(roomName);
        console.log(`🎮 Giocatore ${socket.id} entrato nella stanza: ${roomName}`);
        pool.query('SELECT * FROM game_sessions WHERE room_name = $1', [roomName], (err, result) => {
            if (err) { console.error(err); return; }
            if (result.rows.length > 0) socket.emit('gameStateUpdate', result.rows[0]);
            else pool.query('INSERT INTO game_sessions (room_name) VALUES ($1) RETURNING *', [roomName], (err, res) => {
                if (err) { console.error(err); return; }
                io.to(roomName).emit('gameStateUpdate', res.rows[0]);
            });
        });
    });
    const inc = (col) => (data) => {
        pool.query(`UPDATE game_sessions SET ${col} = ${col} + 1 WHERE room_name = $1 RETURNING *`, [data.room], (err, result) => {
            if (err) { console.error(err); return; }
            io.to(data.room).emit('gameStateUpdate', result.rows[0]);
        });
    };
    socket.on('collectBerry', inc('berries'));   // 2. bacca
    socket.on('collectWood', inc('wood'));       // 3. legna
    socket.on('collectFlower', inc('flowers'));  // 4. fiore
    socket.on('levelUp', inc('level'));          // 6. livello
    socket.on('addMoney', (data) => {            // 5. soldi
        pool.query('UPDATE game_sessions SET money = money + $2 WHERE room_name = $1 RETURNING *', [data.room, data.amount], (err, result) => {
            if (err) { console.error(err); return; }
            io.to(data.room).emit('gameStateUpdate', result.rows[0]);
        });
    });
    socket.on('saveScore', (data) => {
        const { username, score } = data;
        pool.query('INSERT INTO players (username, score) VALUES ($1, $2)', [username, score], (err) => {
            if (err) { console.error('❌ Errore salvataggio:', err); return; }
            console.log(`💾 Punteggio di ${username} salvato!`);
            socket.emit('scoreSaved', { success: true });
        });
    });

    socket.on('disconnect', () => {
        console.log('👋 Giocatore disconnesso:', socket.id);
        if (!me) return;
        const room = me.room;
        room.players.delete(socket.id);
        io.to('mp:' + room.code).emit('mpBye', { id: socket.id });
        if (!room.players.size) saveRoom(room);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server in ascolto sulla porta ${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { for (const r of rooms.values()) await saveRoom(r); process.exit(0); });
