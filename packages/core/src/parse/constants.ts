/**
 * Row geometry and classification constants, pinned in `DECISIONS/0008`.
 *
 * Two of these are the spec's own numbers (0.4 y-band, 5% price tolerance) and the rest fill in
 * the Tier-3 gaps §5 leaves as prose. Changing any of them changes which rows become items, so
 * each carries its decision reference rather than a re-derivation.
 *
 * The provider's reading-order tolerance (`manifest.readingOrder.toleranceRatio`, 0.5) is NOT
 * used here and must not be aligned with {@link ROW_BAND_HEIGHT_RATIO} — see DECISIONS/0007.
 */

/** §5.1 y-band clustering: 40% of the word-count-weighted median word height. */
export const ROW_BAND_HEIGHT_RATIO = 0.4;

/** Floor so a degenerate zero-height word set cannot collapse the page into one row. */
export const MIN_ROW_BAND_TOLERANCE = 1;

/** §5.2 price-column inference: right edges aligning within 5% of image width. */
export const PRICE_COLUMN_WIDTH_RATIO = 0.05;

/**
 * DECISIONS/0008 P5 anchor rows: amount words whose vertical centres fall this close are one anchor
 * line. One printed row can hand the price column several words (a rate, a rounded re-read of the
 * same amount), and those must not become two lines.
 */
export const ANCHOR_MERGE_PX = 8;

/**
 * DECISIONS/0008 P5 anchor rows: aligned amounts the price column needs before its lines are trusted
 * as row anchors. Two members is P6's floor for *inferring* a column; three is the weaker claim that
 * the column repeats down the page, which is what anchoring a whole receipt to it rests on.
 */
export const ANCHOR_MIN_COLUMN_MEMBERS = 3;

/**
 * DECISIONS/0035: the value-column band used by the header-free stage. Narrower than the price column's 5%
 * because several columns must be told apart on one row (a rate 30px left of a GST cell is still a different
 * column), with a floor so a tiny image cannot collapse every band to zero width.
 */
export const VALUE_COLUMN_WIDTH_RATIO = 0.02;
export const VALUE_COLUMN_MIN_TOLERANCE = 6;

/**
 * DECISIONS/0008 P5 anchor rows: how far above its amount's centre a word may sit and still belong
 * to that row, as a fraction of the anchor word's own box height.
 */
export const ANCHOR_UP_REACH_RATIO = 0.25;

/**
 * DECISIONS/0008 P5 anchor rows: the same reach downward, deliberately larger. Name words print
 * lower than the amount they belong to — on the dev receipt a dish name's centre runs 15–29px under
 * its amount's while the row above's amount is only ~43px away — so the row's reach is asymmetric.
 *
 * Both reaches are fractions of the anchor's box height, and both are clamped to the distance to the
 * neighbouring anchor line, so a tall box can never reach past the next row's amount into that row's
 * unit price. Height, not row pitch, is the scale because it is the only measure of a row's text the
 * page offers once the y-band has been shown to fail: a short printed line (`Round off +0.50`, 31px
 * under a 26px-tall amount) stays its own row instead of joining the grand total above it.
 */
export const ANCHOR_DOWN_REACH_RATIO = 0.7;

/** DECISIONS/0008 P1: continuation length cap floor, applied as max(floor, 2 × running median). */
export const CONTINUATION_LENGTH_FLOOR = 20;

/** DECISIONS/0008 P1: the multiplier §5 states as "no more than twice the median". */
export const CONTINUATION_LENGTH_MEDIAN_MULTIPLIER = 2;

/** DECISIONS/0008 P2: an all-caps row longer than this stops reading as a standalone name. */
export const ALL_CAPS_STANDALONE_MAX_LENGTH = 25;

/**
 * DECISIONS/0010 Q1: rows a band needs before its 60% majority is a measurement rather than the
 * receipt's whole item count agreeing with itself. Cost published: 101 CORD item rows keep an
 * unattributed integer and become `unresolved`.
 */
export const QUANTITY_BAND_MIN_ROWS = 5;

/** §5's "at least 60% of its rows contain integers ≤ 20". */
export const QUANTITY_QUALIFY_SHARE = 0.6;

/** §5's integer bound. CORD gold annotates 196 of 198 quantities at ≤ 20; the outliers are 118 and 170. */
export const QUANTITY_MAX_VALUE = 20;

/**
 * DECISIONS/0035 Amendment E: the plausible count for a *paired* numeric row. Wider than 0008's
 * {@link QUANTITY_MAX_VALUE}, which qualifies a quantity *column* on a majority test, because this constant answers
 * a different question — "could these three printed numbers be a count, a rate and a line total?" — and a receipt
 * that sells 100 of something is not a misprint. Still 3 digits, as the amendment says.
 */
export const PAIRING_QUANTITY_MAX_VALUE = 999;
