/**
 * Short codes for pairing a match, and its players, with the separate
 * live-score service.
 *
 * These get typed by hand and read aloud, so the alphabet leaves out
 * anything that can be confused: no 0/O, no 1/I/L, no 5/S, no 8/B.
 * Kept as short as collision-safety allows — a match code only has to
 * be unique across matches, and a player code only within one match.
 */

const ALPHABET = "ACDEFGHJKMNPQRTUVWXY2346799";

function randomCode(length: number): string {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

/**
 * Match codes are 6 characters. With a 27-letter alphabet that's ~387
 * million combinations, so a clash is vanishingly unlikely even before
 * the uniqueness check the caller performs.
 */
export function randomMatchCode(): string {
  return randomCode(6);
}

/**
 * Player codes only need to be unique inside one match — at most a few
 * dozen — so 4 characters is ample and stays easy to retype.
 */
export function randomPlayerCode(): string {
  return randomCode(4);
}

/**
 * Normalises a name for automatic matching.
 *
 * The two services get their squads from different sources, so the same
 * player arrives as "Litton Das", "litton das" or "Litton  Das". Case,
 * spacing, punctuation and accents are all stripped before comparing;
 * anything subtler than that is left for an admin to pair by hand.
 */
export function normaliseName(name: string): string {
  return name
    .normalize("NFD")
    // Strip combining accents: "Pooran" and "Poorán" should match.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
