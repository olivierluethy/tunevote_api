// Pure-logic test for genre ranking shaping (#43).
// Run: node test/run.js test/genre_ranking.test.js
const assert = require("assert");
const { shapeGenreRanking } = require("../services/statsShaping");

module.exports = async function () {
  const out = shapeGenreRanking([
    { genre: "Pop", plays: 6 },
    { genre: "Rock", plays: 3 },
    { genre: "Metal", plays: 1 },
    { genre: null, plays: 0 }, // zero plays dropped
  ]);
  assert.strictEqual(out.length, 3, "zero-play rows dropped");
  assert.strictEqual(out[0].genre, "Pop", "sorted by plays desc");
  assert.strictEqual(out[0].plays, 6);
  assert.strictEqual(out[0].share, 0.6, "share = plays/total");
  assert.strictEqual(out[2].genre, "Metal", "least played last");

  // null genre coalesces to Other and counts
  const out2 = shapeGenreRanking([{ genre: null, plays: 2 }]);
  assert.strictEqual(out2[0].genre, "Other", "null genre -> Other");
  assert.strictEqual(out2[0].share, 1, "single genre has full share");

  assert.deepStrictEqual(shapeGenreRanking([]), [], "empty input -> empty");
  console.log("  genre_ranking: shapeGenreRanking ok");
};
