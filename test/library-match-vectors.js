// Shared vectors for the "already in the library?" rule (ROADMAP UP-19).
//
// The rule has TWO copies: services/library.js (CommonJS, the server's) and
// frontend/src/libraryMatch.js (ESM, the SPA's), because the backend image cannot import
// a frontend source file. test/helpers.test.js runs BOTH over every vector below, so
// the copies can only drift by failing CI. Add a vector here, never to one side.
//
// rows: library rows; game: a search result; want: 'same' | 'possible' | null.
const row = (game_id, game_name, release_date = null) => ({ game_id, game_name, release_date });

module.exports = [
  { name: 'same id', rows: [row('igdb_1', 'Halo', '2001-11-15')], game: { id: 'igdb_1', name: 'Other', releaseDate: null }, want: 'same' },
  { name: 'same name and year, other provider', rows: [row('igdb_1', 'Hades', '2020-09-17')], game: { id: 'rawg_9', name: 'Hades', releaseDate: '2020-01-01' }, want: 'same' },
  { name: 'a remake: same name, different known years (FE-3)', rows: [row('igdb_1', 'Resident Evil 4', '2005-01-11')], game: { id: 'igdb_2', name: 'Resident Evil 4', releaseDate: '2023-03-24' }, want: null },
  { name: 'same name, result undated', rows: [row('igdb_1', 'Hades II', '2024-05-06')], game: { id: 'rawg_9', name: 'Hades II', releaseDate: null }, want: 'possible' },
  { name: 'same name, library row undated', rows: [row('igdb_1', 'Hades II')], game: { id: 'rawg_9', name: 'Hades II', releaseDate: '2024-05-06' }, want: 'possible' },
  { name: 'case and surrounding space are ignored', rows: [row('igdb_1', '  HALO ', '2001-11-15')], game: { id: 'rawg_1', name: 'halo', releaseDate: '2001-01-01' }, want: 'same' },
  { name: 'different names', rows: [row('igdb_1', 'Halo 2', '2004-11-09')], game: { id: 'rawg_1', name: 'Halo', releaseDate: '2001-11-15' }, want: null },
  { name: 'a known-year match beats a possible one', rows: [row('igdb_1', 'Doom'), row('igdb_2', 'Doom', '2016-05-13')], game: { id: 'rawg_1', name: 'Doom', releaseDate: '2016-01-01' }, want: 'same' },
  { name: 'the original and a remake both present, result is the remake', rows: [row('igdb_1', 'Doom', '1993-12-10'), row('igdb_2', 'Doom', '2016-05-13')], game: { id: 'rawg_1', name: 'Doom', releaseDate: '2016-05-13' }, want: 'same' },
  { name: 'an unnamed result matches nothing', rows: [row('igdb_1', '')], game: { id: 'rawg_1', name: '', releaseDate: null }, want: null },
  { name: 'empty library', rows: [], game: { id: 'rawg_1', name: 'Halo', releaseDate: null }, want: null },
  // A STORED name is whitespace-collapsed on write (user-rules.js#sanitizeText); a raw
  // incoming one is not. They must still meet (UP-19 review).
  { name: 'doubled or control-character whitespace in the incoming name', rows: [row('igdb_1', 'Hades II', '2024-05-06')], game: { id: 'rawg_9', name: 'Hades \u0009 II', releaseDate: '2024-01-01' }, want: 'same' },
];
