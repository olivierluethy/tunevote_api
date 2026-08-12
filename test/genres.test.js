// Pure-logic test for the genres taxonomy (no OpenAI / DB needed).
// Run: node test/run.js test/genres.test.js
const assert = require("assert");
const { isGenre, GENRES } = require("../services/genres");

module.exports = async function () {
  assert.strictEqual(isGenre("Pop"), true, "Pop is a genre");
  assert.strictEqual(isGenre("Hip-Hop/Rap"), true, "Hip-Hop/Rap is a genre");
  assert.strictEqual(isGenre("Nonsense"), false, "unknown is not a genre");
  assert.strictEqual(isGenre(null), false, "null is not a genre");
  assert.strictEqual(isGenre(42), false, "number is not a genre");
  assert.ok(GENRES.includes("Other"), "Other is the fallback genre");
  assert.strictEqual(new Set(GENRES).size, GENRES.length, "no duplicate genres");
  console.log("  genres: isGenre + GENRES ok");
};
