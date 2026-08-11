/* ==============================================================================
 * Country-flag resolution, ported from TournamentLiveScores' fwango-bridge.js
 * (resolveFlag() + its supporting tables) so this tool and the live-scores
 * hub resolve a team name to the exact same flagcdn.com/<code>.svg image.
 * Returns a plain ISO2 code (e.g. "AT"), never an emoji.
 * ============================================================================== */

const ISO2_CODES = ['AF','AL','DZ','AS','AD','AO','AG','AR','AM','AU','AT','AZ','BS','BH','BD','BB','BY','BE','BZ','BJ','BT','BO','BA','BW','BR','BN','BG','BF','BI','CV','KH','CM','CA','CF','TD','CL','CN','CO','KM','CG','CD','CR','CI','HR','CU','CY','CZ','DK','DJ','DM','DO','EC','EG','SV','GQ','ER','EE','SZ','ET','FJ','FI','FR','GA','GM','GE','DE','GH','GR','GD','GT','GN','GW','GY','HT','HN','HK','HU','IS','IN','ID','IR','IQ','IE','IL','IT','JM','JP','JO','KZ','KE','KI','KP','KR','KW','KG','LA','LV','LB','LS','LR','LY','LI','LT','LU','MO','MG','MW','MY','MV','ML','MT','MH','MR','MU','MX','FM','MD','MC','MN','ME','MA','MZ','MM','NA','NR','NP','NL','NZ','NI','NE','NG','MK','NO','OM','PK','PW','PS','PA','PG','PY','PE','PH','PL','PT','QA','RO','RU','RW','KN','LC','VC','WS','SM','ST','SA','SN','RS','SC','SL','SG','SK','SI','SB','SO','ZA','SS','ES','LK','SD','SR','SE','CH','SY','TW','TJ','TZ','TH','TL','TG','TO','TT','TN','TR','TM','TV','UG','UA','AE','GB','US','UY','UZ','VU','VA','VE','VN','YE','ZM','ZW'];
const ISO2_SET = new Set(ISO2_CODES);

// Common 3-letter sports/IOC codes that don't match their ISO2 by simple
// truncation (e.g. Germany is "GER" but ISO2 is "DE", not "GE" - Georgia).
const IOC_TO_ISO2 = {
  GER: 'DE', NED: 'NL', SUI: 'CH', DEN: 'DK', POR: 'PT', GRE: 'GR', CRO: 'HR',
  SLO: 'SI', RSA: 'ZA', GBR: 'GB', BUL: 'BG', HUN: 'HU', ROU: 'RO', SVK: 'SK',
  LAT: 'LV', LTU: 'LT', EST: 'EE', BEL: 'BE', LUX: 'LU', PHI: 'PH', SGP: 'SG',
  INA: 'ID', MAS: 'MY', HKG: 'HK', TPE: 'TW', VIE: 'VN', KOR: 'KR', PRK: 'KP',
  UAE: 'AE', KSA: 'SA', ALG: 'DZ', NGR: 'NG', ZAM: 'ZM', ZIM: 'ZW', TAN: 'TZ',
  UGA: 'UG', CHN: 'CN', JPN: 'JP', IND: 'IN', PAK: 'PK', BAN: 'BD', SRI: 'LK',
  NEP: 'NP', MGL: 'MN', AUS: 'AU', NZL: 'NZ', FIJ: 'FJ', ARG: 'AR', CHI: 'CL',
  URU: 'UY', PAR: 'PY', ECU: 'EC', MEX: 'MX', CAN: 'CA', CRC: 'CR', GUA: 'GT',
};

let _nameToCode = null;
function countryNameToCode() {
  if (_nameToCode) return _nameToCode;
  _nameToCode = {};
  const dn = new Intl.DisplayNames(['en'], { type: 'region' });
  for (const c of ISO2_CODES) _nameToCode[dn.of(c).toLowerCase()] = c;
  return _nameToCode;
}

// Country names that double as common personal names or ordinary words -
// excluded from the whole-word search below (tier 3), since matching these
// anywhere in a name is exactly what produces false positives ("Chad" as a
// player's first name, "Turkey" the bird). The two structural patterns
// above them don't need this guard: a name has to be an entire isolated
// segment or a leading code, which "Chad Johnson" never is.
const AMBIGUOUS_COUNTRY_NAMES = new Set(['chad', 'georgia', 'jordan', 'turkey', 'niger', 'guinea', 'mali']);

// Three tiers, most confident first:
//   1. A leading 3-letter IOC/ISO code before " - " ("NOR - Modalsli/...").
//   2. A team name split on " - " where one *entire* segment (after
//      stripping a trailing "(...)" note) exactly equals a country name -
//      "Seed #1 - Argentina (Indiv Men)" -> the segment "Argentina" is the
//      whole thing, not a substring buried inside a longer name.
//   3. A whole-word match anywhere in the string ("Team Argentina", "Club
//      XYZ (Belgium)"), for anything not in AMBIGUOUS_COUNTRY_NAMES.
// No confident match -> no flag, never a guessed one.
export function resolveFlag(teamName) {
  if (!teamName) return '';
  const nameToCode = countryNameToCode();

  const prefixMatch = teamName.match(/^([A-Z]{3})\s*-/);
  if (prefixMatch) {
    const token = prefixMatch[1];
    const iso2 = IOC_TO_ISO2[token] || (ISO2_SET.has(token.slice(0, 2)) ? token.slice(0, 2) : '');
    if (iso2) return iso2;
  }

  for (const rawSegment of teamName.split(/\s+-\s+/)) {
    const segment = rawSegment.replace(/\s*\(.*$/, '').trim().toLowerCase();
    if (nameToCode[segment]) return nameToCode[segment];
  }

  const lower = teamName.toLowerCase();
  for (const [name, code] of Object.entries(nameToCode).sort((a, b) => b[0].length - a[0].length)) {
    if (AMBIGUOUS_COUNTRY_NAMES.has(name)) continue;
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)) return code;
  }
  return '';
}

// { code, name } for every flag this module can resolve, sorted by name -
// used to populate the manual country picker on input.html (see
// Scoreboard.js's populateFlagSelects()) instead of hardcoding ~190 <option>
// tags. Uses the same Intl.DisplayNames source as countryNameToCode() above,
// so a picked name/code pair round-trips through resolveFlag() consistently.
export function getCountryList() {
  const dn = new Intl.DisplayNames(['en'], { type: 'region' });
  return ISO2_CODES
    .map((code) => ({ code, name: dn.of(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
