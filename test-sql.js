// Quick connectivity test: node test-sql.js
// Uses the same config.json and SQL_PASSWORD variable as backup.js
const sql = require('mssql');
const config = require('./config.json');

async function testConnection() {
    try {
        const pool = await sql.connect({
            server: config.server,
            database: config.databaseName,
            user: config.sqlUser,
            password: process.env.SQL_PASSWORD || config.sqlPassword,
            options: { trustServerCertificate: true }
        });
        console.log('Connection successful!');
        await pool.close();
    } catch (error) {
        console.error('Connection error:', error.message);
    }
}

testConnection();
