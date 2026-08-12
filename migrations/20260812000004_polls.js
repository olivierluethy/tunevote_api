/**
 * Live anonymous home-page polls (idea #44).
 *
 *   polls         — one row per poll; is_active selects the single poll shown
 *                   on the home page (exactly one active at a time by convention).
 *   poll_options  — the choices for a poll.
 *   poll_votes    — one vote per voter_key per poll (UNIQUE guard). voter_key is
 *                   a user public_id, a guest token, or an anonymous localStorage
 *                   id supplied by the client.
 *
 * Idempotent — guarded by INFORMATION_SCHEMA so re-runs are no-ops. Seeds one
 * example active poll only when the polls table is empty.
 */

const DB = (knex) => knex.client.config.connection.database;

async function tableExists(knex, table) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`,
    [DB(knex), table],
  );
  return rows.length > 0;
}

exports.up = async function up(knex) {
  if (!(await tableExists(knex, "polls"))) {
    await knex.raw(`
      CREATE TABLE polls (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        question VARCHAR(255) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_polls_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!(await tableExists(knex, "poll_options"))) {
    await knex.raw(`
      CREATE TABLE poll_options (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        poll_id INT NOT NULL,
        label VARCHAR(120) NOT NULL,
        sort INT NOT NULL DEFAULT 0,
        KEY idx_poll_options_poll (poll_id),
        CONSTRAINT poll_options_ibfk_1
          FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!(await tableExists(knex, "poll_votes"))) {
    await knex.raw(`
      CREATE TABLE poll_votes (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        poll_id INT NOT NULL,
        option_id INT NOT NULL,
        voter_key VARCHAR(64) NOT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_poll_voter (poll_id, voter_key),
        KEY idx_poll_votes_option (option_id),
        CONSTRAINT poll_votes_ibfk_1
          FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
        CONSTRAINT poll_votes_ibfk_2
          FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // Seed one example active poll only if none exist yet.
  const [pollCount] = await knex.raw(`SELECT COUNT(*) AS c FROM polls`);
  if (Number(pollCount[0].c) === 0) {
    const [res] = await knex.raw(
      `INSERT INTO polls (question, is_active) VALUES (?, 1)`,
      ["Which genre should power tonight's sessions?"],
    );
    const pollId = res.insertId;
    const options = ["Pop", "Hip-Hop/Rap", "Electronic/Dance", "Rock"];
    for (let i = 0; i < options.length; i++) {
      await knex.raw(
        `INSERT INTO poll_options (poll_id, label, sort) VALUES (?, ?, ?)`,
        [pollId, options[i], i],
      );
    }
  }
};

exports.down = async function down() {
  throw new Error(
    "polls migration is one-way. Restore from backup to roll back.",
  );
};
