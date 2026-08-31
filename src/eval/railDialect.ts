/**
 * ############################  SIMULATOR  ############################
 * A SYNTHETIC rail dialect: decline responses in a vocabulary this build has never
 * mapped. Every code and every description in this file is OUR OWN INVENTION. None is
 * an NPCI return code, a Razorpay error reason, or any real acquirer's wire format.
 * The fictional acquirer is named ACQ so it cannot be mistaken for a real one.
 * #####################################################################
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/domain/taxonomy.ts` is a lookup table. Lookup tables have a specific, known
 * failure mode, and the taxonomy's own comment names it: "a falling coverage rate is
 * the early warning that a rail changed its codes". When a rail changes its vocabulary,
 * or a new acquirer is onboarded, every response classifies as UNKNOWN, and UNKNOWN is
 * never auto-retryable - so the whole cohort escalates to a human and recovers nothing.
 *
 * That is the situation this dialect reproduces, and it is the ONE place where a
 * language model can do something a lookup table structurally cannot: read the text.
 *
 * HOW THE CORPUS IS BUILT, AND WHAT IT CAN AND CANNOT PROVE
 * --------------------------------------------------------
 * Each entry carries a `readable` field, which is the honest part of the design:
 *
 *   readable = <class>   the description states the cause plainly enough that a
 *                        competent reader who had never seen the code should get it
 *                        right. Getting it wrong is a real miss.
 *
 *   readable = null      the description does NOT establish a cause. "Txn not
 *                        processed" is compatible with most of the taxonomy. The
 *                        correct answer is "I do not know", and a model that confidently
 *                        names a class here is WRONG in the dangerous direction, even if
 *                        it happens to guess the simulator's hidden truth.
 *
 * The null entries are not padding. A classifier that reads informative text well is
 * only useful if it also declines to read uninformative text, and roughly a third of
 * this corpus exists to measure that. The eval reports both numbers separately and never
 * averages them into one accuracy figure, because they are different kinds of mistake.
 *
 * LIMITS OF THIS EVIDENCE - state these when presenting it:
 *   1. We wrote these strings. They are modelled on the register of real acquirer
 *      responses (terse, abbreviated, inconsistently capitalised, occasionally
 *      misspelled) but a real unmapped rail could be harder or easier than this.
 *   2. `readable` is our judgement about what the text supports, assigned when the
 *      string was written and not tuned afterwards to suit a result.
 *   3. This measures classification from text. It does not measure whether the model is
 *      a good strategist, which is what `node src/phase3.ts` measures - and there its
 *      contribution is inside run-to-run noise.
 *
 * ONE LABEL CORRECTION, RECORDED RATHER THAN QUIETLY MADE
 * ------------------------------------------------------
 * Three entries - ACQ-404 "authorisation no longer on file", ACQ-414 "instruction not in
 * force", ACQ-423 "instruction state prevents debit" - were first written as `null` and
 * are now MANDATE_NOT_ACTIVE. The first live run scored the model as over-confident on
 * them, and the model was right and the label was wrong: each of these says plainly that
 * the standing instruction is no longer usable, and declines only to say WHY.
 *
 * That is precisely the situation `RAIL_CODE_DETAIL` already resolves to
 * MANDATE_NOT_ACTIVE for Razorpay's own `mandate_not_active`, whose rationale reads: "the
 * description says the mandate is inactive, not why, and asserting a cause would be
 * inventing one." Scoring the model against a stricter standard than the taxonomy applies
 * to itself would have manufactured a safety failure that was not there.
 *
 * A model naming MANDATE_REVOKED for one of these is now scored as a MISREAD, which is
 * the honest verdict - and the eval separately reports that such a misread is immaterial,
 * because every one of these classes is terminal and routes to the same re-authorisation.
 */
import type { FailureClass } from '../domain/taxonomy.ts';

export interface DialectResponse {
  readonly code: string;
  readonly desc: string;
  /**
   * The class the TEXT supports, or null when the text establishes no cause.
   *
   * This is NOT the simulator's ground truth. The simulator knows why the charge really
   * failed; this field records what a reader of the response could legitimately conclude.
   * They differ on purpose, and the gap between them is where over-confident guessing
   * shows up as a win it did not earn.
   */
  readonly readable: FailureClass | null;
}

/**
 * Responses this fictional acquirer emits for each underlying cause.
 *
 * Ordered roughly plain -> terse within each class. The trailing entries of most classes
 * are opaque (`readable: null`): the acquirer returned something for this cause that
 * simply does not say what the cause was, which is the ordinary case in production and
 * the reason the taxonomy has an UNKNOWN class at all.
 */
const CORPUS: Readonly<Record<FailureClass, ReadonlyArray<DialectResponse>>> = {
  INSUFFICIENT_FUNDS: [
    {
      code: 'ACQ-201',
      desc: 'payer account balance below presentment value at time of debit',
      readable: 'INSUFFICIENT_FUNDS',
    },
    {
      code: 'ACQ-202',
      desc: 'funds unavailable; drawee account short of the mandated sum',
      readable: 'INSUFFICIENT_FUNDS',
    },
    { code: 'ACQ-203', desc: 'BAL_SHORT_AT_PRESENTMENT', readable: 'INSUFFICIENT_FUNDS' },
    { code: 'ACQ-204', desc: 'debit not honoured - a/c bal insuff', readable: 'INSUFFICIENT_FUNDS' },
    { code: 'ACQ-205', desc: 'presentment unsuccessful', readable: null },
  ],

  BANK_DOWNTIME: [
    {
      code: 'ACQ-301',
      desc: 'destination institution unreachable during the presentment window',
      readable: 'BANK_DOWNTIME',
    },
    {
      code: 'ACQ-302',
      desc: 'drawee bank host in scheduled maintenance; retry outside window',
      readable: 'BANK_DOWNTIME',
    },
    { code: 'ACQ-303', desc: 'ISSUER_HOST_UNAVAILABLE', readable: 'BANK_DOWNTIME' },
    { code: 'ACQ-304', desc: 'no response from beneficiary bank switch', readable: 'BANK_DOWNTIME' },
    { code: 'ACQ-305', desc: 'routing failure', readable: null },
  ],

  TECHNICAL_DECLINE: [
    {
      code: 'ACQ-101',
      desc: 'transient processing fault at the acquirer; message not delivered downstream',
      readable: 'TECHNICAL_DECLINE',
    },
    {
      code: 'ACQ-102',
      desc: 'internal switch error, transaction not attempted at issuer',
      readable: 'TECHNICAL_DECLINE',
    },
    { code: 'ACQ-103', desc: 'SYS_TXN_TIMEOUT_NO_ISSUER_RESP', readable: 'TECHNICAL_DECLINE' },
    { code: 'ACQ-104', desc: 'temprary technical failure, no debit raised', readable: 'TECHNICAL_DECLINE' },
    { code: 'ACQ-105', desc: 'txn not processed', readable: null },
  ],

  MANDATE_REVOKED: [
    {
      code: 'ACQ-401',
      desc: 'standing instruction withdrawn by the account holder',
      readable: 'MANDATE_REVOKED',
    },
    {
      code: 'ACQ-402',
      desc: 'debit authority cancelled at customer request; no further debits permitted',
      readable: 'MANDATE_REVOKED',
    },
    { code: 'ACQ-403', desc: 'SI_STOPPED_BY_PAYER', readable: 'MANDATE_REVOKED' },
    { code: 'ACQ-404', desc: 'authorisation no longer on file', readable: 'MANDATE_NOT_ACTIVE' },
  ],

  MANDATE_EXPIRED: [
    {
      code: 'ACQ-411',
      desc: 'standing instruction past its stated validity end date',
      readable: 'MANDATE_EXPIRED',
    },
    {
      code: 'ACQ-412',
      desc: 'mandate term elapsed; re-registration required before further presentment',
      readable: 'MANDATE_EXPIRED',
    },
    { code: 'ACQ-413', desc: 'SI_VALIDITY_LAPSED', readable: 'MANDATE_EXPIRED' },
    { code: 'ACQ-414', desc: 'instruction not in force', readable: 'MANDATE_NOT_ACTIVE' },
  ],

  MANDATE_NOT_ACTIVE: [
    {
      code: 'ACQ-421',
      desc: 'registered instruction is not in an active state at the drawee bank',
      readable: 'MANDATE_NOT_ACTIVE',
    },
    { code: 'ACQ-422', desc: 'SI_INACTIVE', readable: 'MANDATE_NOT_ACTIVE' },
    { code: 'ACQ-423', desc: 'instruction state prevents debit', readable: 'MANDATE_NOT_ACTIVE' },
  ],

  AMOUNT_EXCEEDS_MANDATE: [
    {
      code: 'ACQ-431',
      desc: 'presented value exceeds the maximum permitted under the registered instruction',
      readable: 'AMOUNT_EXCEEDS_MANDATE',
    },
    {
      code: 'ACQ-432',
      desc: 'debit amount above the ceiling authorised by the payer',
      readable: 'AMOUNT_EXCEEDS_MANDATE',
    },
    { code: 'ACQ-433', desc: 'AMT_GT_SI_CAP', readable: 'AMOUNT_EXCEEDS_MANDATE' },
    { code: 'ACQ-434', desc: 'amount not acceptable', readable: null },
  ],

  CARD_EXPIRED: [
    {
      code: 'ACQ-501',
      desc: 'the instrument on file is past its printed expiry date',
      readable: 'CARD_EXPIRED',
    },
    {
      code: 'ACQ-502',
      desc: 'stored credential no longer valid - expiry elapsed, update required',
      readable: 'CARD_EXPIRED',
    },
    { code: 'ACQ-503', desc: 'CARD_EXP_DT_PASSED', readable: 'CARD_EXPIRED' },
    { code: 'ACQ-504', desc: 'instrument rejected by issuer', readable: null },
  ],

  ACCOUNT_CLOSED: [
    {
      code: 'ACQ-601',
      desc: 'drawee account closed; no further presentment possible on this account',
      readable: 'ACCOUNT_CLOSED',
    },
    { code: 'ACQ-602', desc: 'ACCT_CLOSED_BY_BANK', readable: 'ACCOUNT_CLOSED' },
    { code: 'ACQ-603', desc: 'a/c no longer maintained at this branch', readable: 'ACCOUNT_CLOSED' },
    { code: 'ACQ-604', desc: 'account status prohibits transaction', readable: null },
  ],

  ACCOUNT_FROZEN: [
    {
      code: 'ACQ-611',
      desc: 'withdrawals on the drawee account are blocked by the bank',
      readable: 'ACCOUNT_FROZEN',
    },
    {
      code: 'ACQ-612',
      desc: 'debit freeze in force on the payer account; credits only',
      readable: 'ACCOUNT_FROZEN',
    },
    { code: 'ACQ-613', desc: 'DR_FREEZE_ACTIVE', readable: 'ACCOUNT_FROZEN' },
    { code: 'ACQ-614', desc: 'operation not permitted on this account', readable: null },
  ],

  RISK_DECLINE: [
    {
      code: 'ACQ-701',
      desc: 'transaction refused by the issuer fraud and risk engine',
      readable: 'RISK_DECLINE',
    },
    {
      code: 'ACQ-702',
      desc: 'declined - payer flagged under the bank risk programme',
      readable: 'RISK_DECLINE',
    },
    { code: 'ACQ-703', desc: 'RISK_RULE_HIT_DECLINE', readable: 'RISK_DECLINE' },
    { code: 'ACQ-704', desc: 'refer to issuer', readable: null },
  ],

  /**
   * The simulator never chooses UNKNOWN as a cause - UNKNOWN is a statement about our
   * classification, not about the world. Present so the record is total, and so a future
   * change to the simulator cannot silently fall through this table.
   */
  UNKNOWN: [{ code: 'ACQ-999', desc: 'transaction declined', readable: null }],
};

/** Human-readable name for the dialect. Appears in every banner that reports on it. */
export const DIALECT_NAME = 'synthetic-acquirer-v1 (ACQ)';

/**
 * Pick the response this acquirer returns for `cls`, given a uniform draw in [0, 1).
 *
 * The draw is supplied by the caller and derived from (seed, subscription, attempt), so
 * a cohort built on a given seed always presents the identical strings. The eval would
 * be worthless otherwise: a model scored against a corpus that reshuffles per run cannot
 * be compared with itself.
 */
export function dialectResponse(cls: FailureClass, u: number): DialectResponse {
  const options = CORPUS[cls];
  const i = Math.min(options.length - 1, Math.floor(u * options.length));
  return options[i]!;
}

/** Every response in the corpus. Used by the eval to report its composition. */
export function allDialectResponses(): ReadonlyArray<DialectResponse & { cause: FailureClass }> {
  return Object.entries(CORPUS).flatMap(([cause, rs]) =>
    rs.map((r) => ({ ...r, cause: cause as FailureClass })),
  );
}

/**
 * Guard: no dialect code may collide with anything the taxonomy already maps.
 *
 * If one ever did, the "unmapped" cohort would quietly contain mapped codes and the
 * eval would be measuring the lookup table while claiming to measure the model. Checked
 * by test rather than asserted in prose.
 */
export function dialectCodes(): ReadonlyArray<string> {
  return allDialectResponses().map((r) => r.code);
}
