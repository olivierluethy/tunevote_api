// ---------------------------------------------------------------------------
// Session authorisation predicates (idea #24: host / co-host / member).
//
// Pure and data-driven: callers resolve the session owner id, the acting user
// id, and (for co-host) that user's session_participants.role, then ask here.
// Keeping these pure makes them unit-testable and keeps the role policy in one
// place.
//
//   host          — the session owner (sessions.user_id). Exactly one.
//   co-host       — a logged-in participant the host has promoted; shares host
//                   powers EXCEPT deleting the session and changing roles.
//   member/guest  — no host powers.
// ---------------------------------------------------------------------------

// True when userId owns the session.
function isHost(sessionOwnerUserId, userId) {
  return (
    userId != null &&
    sessionOwnerUserId != null &&
    Number(sessionOwnerUserId) === Number(userId)
  );
}

// True when userId is the host OR holds the 'co-host' role in the session.
// participantRole is the caller's session_participants.role (or null/undefined).
function isHostOrCoHost(sessionOwnerUserId, userId, participantRole) {
  return isHost(sessionOwnerUserId, userId) || participantRole === "co-host";
}

module.exports = { isHost, isHostOrCoHost };
