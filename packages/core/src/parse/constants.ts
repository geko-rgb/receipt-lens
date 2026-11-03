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
