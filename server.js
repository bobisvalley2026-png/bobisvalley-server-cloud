const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg'); // Nuova libreria per PostgreSQL
const fs = require('fs');

// Connessione al database PostgreSQL (i dati verranno presi da Render)
const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: true,
        ca: fs.readFileSync('./ca.pem').toString(), // Legge il certificato
    },
});

// Test di connessione
pool.connect((err, client, release) => {
    if (err) {
        return console.error('❌ Errore di connessione al DB:', err.stack);
    }
    console.log('✅ Connesso al database PostgreSQL!');
    release();
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Permette a GitHub Pages di connettersi
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log('🎮 Giocatore connesso:', socket.id);

    // --- INIZIO BLOCCO MULTIPLAYER ---
     // --- LOGICA PER IL MULTIPLAYER ---

    // 1. Quando un giocatore si connette a una stanza multiplayer
    socket.on('joinGame', (data) => {
        const roomName = data.room; // Esempio: "stanza-amici-1"
        socket.join(roomName);
        console.log(`🎮 Giocatore ${socket.id} entrato nella stanza: ${roomName}`);

        // Cerca se esiste già una partita per questa stanza
        const sql = 'SELECT * FROM game_sessions WHERE room_name = $1';
        pool.query(sql, [roomName], (err, result) => {
            if (err) { console.error(err); return; }

            if (result.rows.length > 0) {
                // La partita esiste già: invia i dati al giocatore che si è appena connesso
                socket.emit('gameStateUpdate', result.rows[0]);
            } else {
                // La partita non esiste: creala!
                const insertSql = 'INSERT INTO game_sessions (room_name) VALUES ($1) RETURNING *';
                pool.query(insertSql, [roomName], (err, res) => {
                    if (err) { console.error(err); return; }
                    // Invia i dati iniziali a tutti i giocatori nella stanza
                    io.to(roomName).emit('gameStateUpdate', res.rows[0]);
                });
            }
        });
    });

    // 2. Quando un giocatore raccoglie una bacca
    socket.on('collectBerry', (data) => {
        const roomName = data.room;
        // Aggiunge 1 bacca al totale della stanza
        const sql = 'UPDATE game_sessions SET berries = berries + 1 WHERE room_name = $1 RETURNING *';
        pool.query(sql, [roomName], (err, result) => {
            if (err) { console.error(err); return; }
            // Invia il nuovo stato aggiornato a TUTTI i giocatori nella stanza
            io.to(roomName).emit('gameStateUpdate', result.rows[0]);
        });
    });

    // 3. Quando un giocatore guadagna soldi (esempio)
    socket.on('addMoney', (data) => {
        const roomName = data.room;
        const amount = data.amount;
        const sql = 'UPDATE game_sessions SET money = money + $1 WHERE room_name = $1 RETURNING *';
        pool.query(sql, [roomName, amount], (err, result) => {
            if (err) { console.error(err); return; }
            io.to(roomName).emit('gameStateUpdate', result.rows[0]);
        });
    });

    // 4. Quando un giocatore sale di livello (esempio)
    socket.on('levelUp', (data) => {
        const roomName = data.room;
        const sql = 'UPDATE game_sessions SET level = level + 1 WHERE room_name = $1 RETURNING *';
        pool.query(sql, [roomName], (err, result) => {
            if (err) { console.error(err); return; }
            io.to(roomName).emit('gameStateUpdate', result.rows[0]);
        });
    });
    // --- FINE BLOCCO MULTIPLAYER ---

    // Salva un punteggio nel database (Nota la sintassi $1, $2 di PostgreSQL)
    socket.on('saveScore', (data) => {
        const { username, score } = data;
        const sql = 'INSERT INTO players (username, score) VALUES ($1, $2)';
        pool.query(sql, [username, score], (err, result) => {
            if (err) {
                console.error('❌ Errore salvataggio:', err);
                return;
            }
            console.log(`💾 Punteggio di ${username} salvato!`);
            socket.emit('scoreSaved', { success: true });
        });
    });

    socket.on('disconnect', () => {
        console.log('👋 Giocatore disconnesso:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server in ascolto sulla porta ${PORT}`);
});
