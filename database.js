const isPostgres = !!process.env.DATABASE_URL;

let db;

if (isPostgres) {
    const { Pool } = require('pg');
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    
    db = {
        query: async (text, params) => {
            const result = await pool.query(text, params);
            return { rows: result.rows };
        },
        init: async () => {
            const client = await pool.connect();
            try {
                await client.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password TEXT NOT NULL, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, draws INTEGER DEFAULT 0, elo INTEGER DEFAULT 1000)`);
                // Migration for existing users
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS elo INTEGER DEFAULT 1000`);
                await client.query(`CREATE TABLE IF NOT EXISTS games (id SERIAL PRIMARY KEY, player1_id INTEGER, player2_id INTEGER, winner_id INTEGER, board_state TEXT, played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
            } finally { client.release(); }
        }
    };
    console.log('Using PostgreSQL (Cloud Mode)');
} else {
    const Database = require('better-sqlite3');
    const sqlite = new Database('game.db');
    
    db = {
        query: async (text, params) => {
            // Convert PG syntax ($1, $2) to SQLite (?)
            const sqliteText = text.replace(/\$\d+/g, '?');
            const stmt = sqlite.prepare(sqliteText);
            if (sqliteText.trim().toLowerCase().startsWith('select')) {
                return { rows: stmt.all(params || []) };
            } else {
                return { rows: [stmt.run(params || [])] };
            }
        },
        init: async () => {
            sqlite.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password TEXT NOT NULL, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, draws INTEGER DEFAULT 0, elo INTEGER DEFAULT 1000)`);
            
            // Migration for existing users (handy for dev)
            try { sqlite.exec(`ALTER TABLE users ADD COLUMN elo INTEGER DEFAULT 1000`); } catch(e) {}
            sqlite.exec(`CREATE TABLE IF NOT EXISTS games (id INTEGER PRIMARY KEY AUTOINCREMENT, player1_id INTEGER, player2_id INTEGER, winner_id INTEGER, board_state TEXT, played_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        }
    };
    console.log('Using SQLite (Local Mode)');
}

db.init();

module.exports = db;


