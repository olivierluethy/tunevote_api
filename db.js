const mysql = require("mysql2/promise");

// Shared MySQL connection pool. Requires dotenv to already be configured
// (index.js calls require("dotenv").config() before requiring this module).
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "tunevote",
  // Match the tables' utf8mb4 charset on the connection itself. Without this the
  // client negotiates the server default (often latin1/utf8mb3), which turns
  // stored ä/é/ü into mojibake (Ã¤/Ã©/Ã¼) on the way out. Mirrors knexfile.js.
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;
