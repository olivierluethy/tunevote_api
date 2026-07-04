const crypto = require("crypto");
const bcrypt = require("bcrypt");

// Random hex token for password-reset links.
const generateResetToken = () => crypto.randomBytes(32).toString("hex");

// Bcrypt hash with a cost of 10.
const hashPassword = (password) => bcrypt.hash(password, 10);

// Convert an ISO-8601 duration (e.g. "PT3M20S") to seconds.
const parseIsoDuration = (iso) => {
  let seconds = 0;
  const matches = iso.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
  if (matches) {
    seconds += (parseInt(matches[1]) || 0) * 3600;
    seconds += (parseInt(matches[2]) || 0) * 60;
    seconds += parseInt(matches[3]) || 0;
  }
  return seconds;
};

// Normalise a title for fuzzy comparison (lowercase, strip punctuation).
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Read a scalar aggregate (e.g. COUNT) out of a mysql2 result set.
const getScalar = (result, field = "count") => result?.[0]?.[field] ?? 0;

// Read a single named field from the first row of a result set.
const getSingleValue = (result, field) => result?.[0]?.[field] ?? 0;

module.exports = {
  generateResetToken,
  hashPassword,
  parseIsoDuration,
  normalize,
  getScalar,
  getSingleValue,
};
