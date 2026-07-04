const mysql = require("mysql2/promise");

// Shared MySQL connection pool. Requires dotenv to already be configured
// (index.js calls require("dotenv").config() before requiring this module).
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "tunevote",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;
