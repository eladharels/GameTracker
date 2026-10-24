// What the Android app (mobile/) asks of the backend.
//
// Not a test: a helper shared by api-surface.test.js (every route the app calls exists, at a
// tier the app can reach) and api-contract.test.js (every field the app binds is a field a
// pinned response carries). The app is the v1 client the freeze exists for, and it lives in
// this repository, so a backend rename that would break it can fail CI by name.
//
// MOB-25: the contract is mobile/api-contract.json, written by a JVM test in mobile/
// (ApiContractTest) by REFLECTION over the compiled Retrofit interface and Gson models. That
// test fails in the Android job when the file no longer matches the code, and it refuses
// @SerializedName, @JsonAdapter, @HTTP and @Url. This file used to regex-parse the Kotlin,
// which broke on formatting and could silently find nothing. It still FAILS CLOSED: minimum
// counts, anchors, and cross-checks against the source that a stale JSON would fail.
const fs = require('fs');
const path = require('path');

const MOBILE_DIR = path.join(__dirname, '..', 'mobile');
const SRC = path.join(MOBILE_DIR, 'app/src/main/java/ink/etech/gametracker');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const contractFile = () => JSON.parse(fs.readFileSync(path.join(MOBILE_DIR, 'api-contract.json'), 'utf8'));

// The JSON key for each models.kt class: Game -> game, LoginRequest -> loginRequest.
const keyOf = (cls) => cls[0].toLowerCase() + cls.slice(1);

// [{method, path, key}] with Retrofit's relative paths turned into Express keys:
// "user/{username}/games" -> "/api/user/:username/games".
function apiRoutes() {
  const routes = contractFile().routes.map((r) => {
    const [method, p] = r.split(' ');
    const expressPath = `/api/${p.replace(/^\//, '').replace(/\{(\w+)\}/g, ':$1')}`;
    return { method, path: expressPath, key: `${method} ${expressPath}` };
  });
  // A stale file: the interface gained or lost a route the JSON does not show.
  const annotations = (read('GameTrackerApi.kt').match(/^\s*@(GET|POST|PUT|DELETE|PATCH)\b/gm) || []).length;
  if (routes.length !== annotations) {
    throw new Error(`api-contract.json has ${routes.length} routes, GameTrackerApi.kt ${annotations}: regenerate it (GT_WRITE_CONTRACT=1)`);
  }
  if (routes.length < 7) throw new Error(`only ${routes.length} routes in api-contract.json`);
  for (const anchor of ['POST /api/auth/login', 'GET /api/games/search', 'GET /api/user/:username/games']) {
    if (!routes.some((r) => r.key === anchor)) throw new Error(`anchor route ${anchor} not in api-contract.json`);
  }
  return routes;
}

// Gson's field NAMING can also be changed once for the whole client, far from the models: a
// GsonBuilder with a naming policy handed to the converter renames every field on the wire.
function assertPlainGson() {
  const text = read('ApiClient.kt');
  if (/GsonBuilder|FieldNamingPolicy|FieldNamingStrategy/.test(text) || !/GsonConverterFactory\.create\(\)/.test(text)) {
    throw new Error('ApiClient.kt configures Gson itself: field names on the wire may differ from models.kt');
  }
}

function mobileContract() {
  const json = contractFile();
  // Every data class in models.kt is in the JSON, and nothing else is.
  const classes = [...read('models.kt').matchAll(/^data class (\w+)\(/gm)].map((m) => keyOf(m[1])).sort();
  const keys = Object.keys(json).filter((k) => k !== 'routes').sort();
  if (JSON.stringify(classes) !== JSON.stringify(keys)) {
    throw new Error(`api-contract.json models [${keys}] differ from models.kt [${classes}]: regenerate it (GT_WRITE_CONTRACT=1)`);
  }
  const game = json.game;
  if (!Array.isArray(game) || game.length < 12 || !game.includes('game_id') || !game.includes('backlog_order')) {
    throw new Error(`Game in api-contract.json is [${game}]: the file is broken`);
  }
  assertPlainGson();
  return {
    routes: apiRoutes(),
    game,
    loginResponse: json.loginResponse,
    loginRequest: json.loginRequest,
    gameUpdateRequest: json.gameUpdateRequest,
    backlogReorderRequest: json.backlogReorderRequest,
    createTokenRequest: json.createTokenRequest,
    createdToken: json.createdToken,
    gameUpsertResult: json.gameUpsertResult,
  };
}

module.exports = { mobileContract, apiRoutes, SRC };
