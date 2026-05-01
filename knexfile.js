require("dotenv").config();

const base = {
  client: "mysql2",
  connection: {
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "tunevote",
    port: Number(process.env.DB_PORT || 3306),
    multipleStatements: true,
    charset: "utf8mb4",
  },
  pool: { min: 0, max: 5 },
  migrations: {
    directory: "./migrations",
    tableName: "knex_migrations",
    extension: "js",
  },
};

module.exports = {
  development: base,
  staging: base,
  production: base,
};
