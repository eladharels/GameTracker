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

// The constructor properties of `data class <name>(...)` in Kotlin source `text`, in order.
// The parameter list ends at its BALANCED closing paren: a lazy match stopped at the first `)`
// ending a line, so `@Expose(serialize = false)` or a multi-line default silently cut the
// class short (Architect review, PR #6). Any annotation with arguments inside the list is
// refused outright: it is how a name or a (de)serialisation rule gets changed.
function parseDataClass(text, name) {
  const head = new RegExp(`data class ${name}\\s*\\(`).exec(text);
  if (!head) throw new Error(`data class ${name} not found`);
  let depth = 1;
  let i = head.index + head[0].length;
  const start = i;
  for (; i < text.length && depth > 0; i++) {
    // A paren inside a string or char literal is not structure (`val a: String = ")"` hid
    // the next field, Architect re-review). Raw strings first, then escaped ones.
    if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      if (end < 0) break;
      i = end + 2;
    } else if (text[i] === '"' || text[i] === "'") {
      const q = text[i];
      for (i++; i < text.length && text[i] !== q; i++) if (text[i] === '\\') i++;
    } else if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
  }
  if (depth !== 0) throw new Error(`data class ${name}: unbalanced parentheses`);
  const body = text.slice(start, i - 1).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@[\w.:]+\s*\(/.test(body)) throw new Error(`data class ${name} has an annotation with arguments: extend mobile-api.js before relying on it`);
  const declared = (body.match(/\b(val|var)\b/g) || []).length;
  const fields = [...body.matchAll(/\b(?:val|var)\s+(\w+)\s*:/g)].map((x) => x[1]);
  if (fields.length !== declared || fields.length === 0) throw new Error(`parsed ${fields.length} of ${declared} properties of ${name}`);
  return fields;
}

function dataClassFields(name) {
  const text = read('models.kt');
  if (REFUSED.test(text)) throw new Error(`models.kt uses ${REFUSED.exec(text)[0]}: extend mobile-api.js before relying on it`);
  return parseDataClass(text, name);
}

// Gson's field NAMING can also be changed once for the whole client, far from the models: a
// GsonBuilder with a naming policy handed to the converter renames every field on the wire.
function assertPlainGson() {
  const text = read('ApiClient.kt');
  if (/GsonBuilder|FieldNamingPolicy|FieldNamingStrategy/.test(text) || !/GsonConverterFactory\.create\(\)/.test(text)) {
    throw new Error('ApiClient.kt configures Gson itself: field names on the wire may differ from models.kt');
  }
}

// The full picture, with the anchors that prove the parse saw the real classes.
function mobileContract() {
  const game = dataClassFields('Game');
  if (game.length < 12 || !game.includes('game_id') || !game.includes('backlog_order')) {
    throw new Error(`Game parsed as [${game}]: the parse is broken`);
  }
  assertPlainGson();
  return {
    routes: apiRoutes(),
    game,
    loginResponse: dataClassFields('LoginResponse'),
    loginRequest: dataClassFields('LoginRequest'),
    gameUpdateRequest: dataClassFields('GameUpdateRequest'),
    backlogOrderRequest: dataClassFields('BacklogOrderRequest'),
  };
}

module.exports = { mobileContract, apiRoutes, dataClassFields, parseDataClass, SRC };
