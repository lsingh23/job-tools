/**
 * Is a LinkedIn card's location somewhere you could actually take the job?
 *
 * WHY THIS EXISTS. The guest search endpoint does NOT honour `geoId` as a hard
 * filter. Once the in-geo pool for a (keyword × f_TPR window) pair is exhausted
 * it keeps serving full 10-card pages by quietly DROPPING the geo constraint and
 * padding with worldwide results — so the loop's end-of-results break never
 * fires and the overflow is indistinguishable, in the response, from a real hit.
 *
 * Measured live 2026-08-20, `keywords=React.js Developer`, geoId=102713980
 * (India), f_TPR=r7200 (the production 2h window):
 *
 *   with f_WT=2 (remote)  page 1 → 8 of 10 cards abroad: İzmir, Istanbul,
 *                         Blacksburg VA, Tel Aviv, Munich, Brazil, Graz, Berlin
 *   without f_WT          page 1 clean, then start=20/30/40 → Australia, Spain,
 *                         Sweden, Bangladesh, Singapore, Philippines, UAE
 *
 * The remote sweep leaks first and worst because the India remote pool in a 2h
 * window is only a few postings deep, but the leak is NOT remote-specific — any
 * location entry does it once its pool runs dry, which is what deep pages are.
 * At a 24h window the same queries stay clean, so this is invisible in tuning
 * scripts and only shows up in production.
 *
 * WHY A STRICT KEEP-LIST AND NOT ats.ts's `isForeignOnly` BLOCK-LIST. That one
 * is tuned for ATS boards, whose location field is free text typed by a human
 * ("Remote - CO, FL, GA", "USA Only - 100% Remote"), where anything unlisted
 * must be KEPT or you delete real jobs. LinkedIn is the opposite: its location
 * is a structured geo ENTITY, always either "…, India" or a named metro
 * ("Greater Chennai Area", "Mumbai Metropolitan Region"), so a keep-list is
 * exact here — and it catches the ones a block-list misses, e.g. "Blacksburg,
 * VA" (one US state code, and US_STATE_RE needs two) and "Greater Graz".
 *
 * Validated against all 12,202 LinkedIn rows in the DB (273 distinct location
 * strings): drops exactly 17 rows, every one of them genuinely foreign, with no
 * Indian false positive. Callers log every drop so a future miss is visible
 * rather than silent.
 */

/** Cities, states and UTs, plus the bare country name. Substring match. */
const INDIA_TOKENS = [
  "india",
  // metros + tier-2 cities (LinkedIn also emits "Greater <city> Area" and
  // "<city> Metropolitan Region" forms, which these match as substrings)
  "bengaluru", "bangalore", "bangaluru", "hyderabad", "secunderabad",
  "pune", "pimpri", "chinchwad", "hinjewadi", "mumbai", "bombay", "thane",
  "chennai", "gurgaon", "gurugram", "noida", "delhi", "ncr", "kolkata",
  "calcutta", "ahmedabad", "gandhinagar", "vadodara", "surat", "rajkot",
  "jaipur", "udaipur", "jodhpur", "indore", "bhopal", "chandigarh", "mohali",
  "ludhiana", "amritsar", "kochi", "cochin", "ernakulam", "trivandrum",
  "thiruvananthapuram", "calicut", "kozhikode", "coimbatore", "madurai",
  "trichy", "tiruchirappalli", "mysore", "mysuru", "mangaluru", "mangalore",
  "nagpur", "nashik", "aurangabad", "visakhapatnam", "vizag", "vijayawada",
  "bhubaneswar", "guwahati", "patna", "ranchi", "raipur", "dehradun",
  "lucknow", "kanpur", "varanasi", "prayagraj", "agra", "ghaziabad",
  "faridabad", "meerut", "goa", "panaji",
  // states / UTs — the safety net for sub-city entities ("Sadar, Uttar
  // Pradesh", "Mohali district") and for towns too small to list above
  "karnataka", "telangana", "andhra pradesh", "maharashtra", "tamil nadu",
  "kerala", "gujarat", "rajasthan", "punjab", "haryana", "uttar pradesh",
  "uttarakhand", "madhya pradesh", "chhattisgarh", "west bengal", "odisha",
  "orissa", "jharkhand", "bihar", "assam", "himachal", "jammu", "kashmir",
  "tripura", "manipur", "meghalaya", "nagaland", "mizoram", "sikkim",
  "arunachal", "puducherry", "pondicherry",
];

/**
 * A location that names no place at all. Kept on purpose: a bare "Remote" from
 * an India-geo search is a role that didn't bother to name a city, not a
 * foreign one. A remote job that DOES name somewhere else ("Remote, Germany")
 * still fails the India test and is dropped.
 */
const OPEN_TOKENS = ["remote", "anywhere", "work from home", "wfh", "distributed", "worldwide"];

export function isIndiaLocation(location: string): boolean {
  const l = location.toLowerCase();
  return INDIA_TOKENS.some((t) => l.includes(t));
}

/** True = keep the card. Empty string keeps (the caller substitutes its own label). */
export function isReachableFromIndia(location: string): boolean {
  const s = location.trim();
  if (!s) return true;
  const l = s.toLowerCase();
  return isIndiaLocation(l) || OPEN_TOKENS.some((t) => l.includes(t));
}
