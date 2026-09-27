// What the Android app (mobile/) asks of the backend, read from its own source.
//
// Not a test: a helper shared by api-surface.test.js (every route the app calls exists, at a
// tier the app can reach) and api-contract.test.js (every field the app binds is a field a
// pinned response carries). The app is the v1 client the freeze exists for, and it lives in
// this repository now, so a backend rename that would break it can fail CI by name.
//
// It parses Kotlin with regular expressions, so it FAILS CLOSED rather than quietly finding
// nothing: minimum counts, named anchors that must be found, and a refusal of every Retrofit
// or Gson construct that would make a name in the source differ from the name on the wire
// (@SerializedName, @HTTP, @Url, @JsonAdapter). A sturdier source of truth -- a JVM test in
// mobile/ that writes the contract as JSON by reflection -- is recorded in mobile/ROADMAP.md.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'mobile/app/src/main/java/com/example/gmaetrackermobile');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const REFUSED = /@(SerializedName|HTTP|Url|JsonAdapter|FormUrlEncoded|Multipart)\b/;

// [{method, path}] with Retrofit's relative paths turned into Express keys:
// "user/{username}/games" -> "/api/user/:username/games".
function apiRoutes() {
  const text = read('GameTrackerApi.kt');
  if (REFUSED.test(text)) throw new Error(`GameTrackerApi.kt uses ${REFUSED.exec(text)[0]}: extend mobile-api.js before relying on it`);
  const routes = [...text.matchAll(/@(GET|POST|PUT|DELETE|PATCH)\("([^"]+)"\)/g)].map(([, method, p]) => ({
    method,
    path: `/api/${p.replace(/^\//, '').replace(/\{(\w+)\}/g, ':$1')}`,
    key: `${method} /api/${p.replace(/^\//, '').replace(/\{(\w+)\}/g, ':$1')}`,
  }));
  const annotations = (text.match(/^\s*@(GET|POST|PUT|DELETE|PATCH)\b/gm) || []).length;
  if (routes.length !== annotations) throw new Error(`parsed ${routes.length} of ${annotations} route annotations in GameTrackerApi.kt`);
  if (routes.length < 7) throw new Error(`only ${routes.length} routes parsed from GameTrackerApi.kt; the parse is broken`);
  for (const anchor of ['POST /api/auth/login', 'GET /api/games/search', 'GET /api/user/:username/games']) {
    if (!routes.some((r) => r.key === anchor)) throw new Error(`anchor route ${anchor} not found in GameTrackerApi.kt`);
  }
  return routes;
}

// The constructor properties of `data class <name>(...)` in models.kt, in order.
function dataClassFields(name) {
  const text = read('models.kt');
  if (REFUSED.test(text)) throw new Error(`models.kt uses ${REFUSED.exec(text)[0]}: extend mobile-api.js before relying on it`);
  const m = new RegExp(`data class ${name}\\s*\\(([\\s\\S]*?)\\)\\s*(?::|\\{|$)`, 'm').exec(text);
  if (!m) throw new Error(`data class ${name} not found in models.kt`);
  const body = m[1].replace(/\/\/.*$/gm, '');
  const declared = (body.match(/\b(val|var)\b/g) || []).length;
  const fields = [...body.matchAll(/\b(?:val|var)\s+(\w+)\s*:/g)].map((x) => x[1]);
  if (fields.length !== declared || fields.length === 0) throw new Error(`parsed ${fields.length} of ${declared} properties of ${name}`);
  return fields;
}

// The full picture, with the anchors that prove the parse saw the real classes.
function mobileContract() {
  const game = dataClassFields('Game');
  if (game.length < 12 || !game.includes('game_id') || !game.includes('backlog_order')) {
    throw new Error(`Game parsed as [${game}]: the parse is broken`);
  }
  return {
    routes: apiRoutes(),
    game,
    loginResponse: dataClassFields('LoginResponse'),
    loginRequest: dataClassFields('LoginRequest'),
    gameUpdateRequest: dataClassFields('GameUpdateRequest'),
    backlogOrderRequest: dataClassFields('BacklogOrderRequest'),
  };
}

module.exports = { mobileContract, apiRoutes, dataClassFields, SRC };
