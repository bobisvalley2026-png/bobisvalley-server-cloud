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