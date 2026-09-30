/**
 * Result codes used by the wire timeline format.
 *
 * The wire format deliberately uses small integers instead of strings so the
 * multi-megabyte timeline payload stays compact.
 */

export const RESULT = Object.freeze({
  AC: 1,
  FB: 2,
  RJ: 3,
  WA: 4,
  PE: 5,
  TLE: 6,
  MLE: 7,
  OLE: 8,
  IDLE: 9,
  RTE: 10,
  NOUT: 11,
  CE: 12,
  UKE: 13,
  UNKNOWN: 99,
});

export const RESULT_NAME = Object.freeze(
  Object.fromEntries(Object.entries(RESULT).map(([name, code]) => [code, name])),
);

/** Result codes that mean "this submission solved the problem". */
export const ACCEPTED_CODES = Object.freeze([RESULT.AC, RESULT.FB]);

export const isAccepted = (code) => code === RESULT.AC || code === RESULT.FB;

/**
 * Turn an SRK result string into a wire result code.
 * @param {unknown} result
 * @returns {number}
 */
export function encodeResult(result) {
  if (result === null || result === undefined || result === '') return RESULT.UNKNOWN;
  const upper = String(result).toUpperCase();
  return Object.prototype.hasOwnProperty.call(RESULT, upper)
    ? RESULT[upper]
    : RESULT.UNKNOWN;
}

/**
 * Turn a wire result code back into an SRK result string.
 * @param {number} code
 * @returns {string}
 */
export function decodeResult(code) {
  return RESULT_NAME[code] ?? 'UNKNOWN';
}

/** Seconds in each SRK time unit. */
const UNIT_SECONDS = Object.freeze({
  ms: 1 / 1000,
  s: 1,
  min: 60,
  h: 3600,
  d: 86400,
});

/**
 * SRK durations are `[value, unit]` tuples. Normalise them to seconds.
 * Also accepts a bare number (already seconds) and `null`/`undefined`.
 *
 * @param {unknown} duration
 * @param {number|null} [fallback]
 * @returns {number|null} seconds, or the fallback when the input is malformed
 */
export function durationToSeconds(duration, fallback = null) {
  if (duration === null || duration === undefined) return fallback;
  if (typeof duration === 'number') return Number.isFinite(duration) ? duration : fallback;
  if (typeof duration === 'string') {
    const parsed = Number(duration);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (Array.isArray(duration)) {
    const [value, unit] = duration;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const scale = UNIT_SECONDS[unit];
    if (scale === undefined) return fallback;
    return numeric * scale;
  }
  return fallback;
}

/**
 * SRK text fields are either a plain string or an i18n set with a `fallback`.
 * Prefer Simplified Chinese, then English, then the fallback.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function textToString(text) {
  if (text === null || text === undefined) return '';
  if (typeof text === 'string') return text;
  if (typeof text === 'number') return String(text);
  if (typeof text !== 'object') return '';
  for (const key of ['zh-CN', 'zh', 'en-US', 'en']) {
    if (typeof text[key] === 'string') return text[key];
  }
  if (typeof text.fallback === 'string') return text.fallback;
  for (const value of Object.values(text)) {
    if (typeof value === 'string') return value;
  }
  return '';
}

/**
 * The default `noPenaltyResults` list from the SRK spec, used when the
 * ranklist does not declare its own sorter configuration.
 */
export const SRK_DEFAULT_NO_PENALTY_RESULTS = Object.freeze([
  'FB',
  'AC',
  '?',
  'NOUT',
  'CE',
  'UKE',
  null,
]);
