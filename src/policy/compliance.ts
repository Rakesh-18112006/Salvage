/**
 * SOURCED REGULATORY PARAMETERS.
 *
 * Spec rule 1: "Do not invent regulatory facts. Any RBI e-mandate rule, NPCI eNACH return
 * code, or Razorpay error code must come from the official source."
 *
 * Unlike every other constant in this project, the values in this file are NOT stand-ins.
 * Each was read from the issuing body's own website and carries its citation, section
 * number, and a verbatim quote. Nothing here may change without its citation changing.
 *
 * ============================ THE CURRENT INSTRUMENT ============================
 * Most material written about Indian e-mandates cites RBI/2019-20/47
 * (DPSS.CO.PD.No.447/02.14.003/2019-20, 21 August 2019). That circular has been REPEALED.
 *
 * The instrument in force is:
 *
 *   Digital Payments - E-mandate Framework, 2026
 *   RBI/DPSS/2026-27/396
 *   RBI/CO.DPSS.POLC.No.S56/02.14.003/2026-27
 *   Dated 21 April 2026; "These Directions shall be effective immediately."
 *   https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=13374
 *
 * Issued under Sections 10(2) read with 18 of the Payment and Settlement Systems Act,
 * 2007. It consolidates and repeals the earlier e-mandate circulars.
 *
 * Retrieved and re-verified 2026-08-31 by two independent reads of the RBI page, which
 * agreed on every figure and section number quoted below.
 * ================================================================================
 *
 * ===================== SCOPE LIMIT THAT MATTERS TO THIS PROJECT =================
 * Section 2 (Applicability), verbatim:
 *
 *   "The provisions of these Directions shall be applicable to all Payment System
 *    Providers and Payment System Participants in respect of processing of recurring
 *    transactions, domestic or cross-border, using cards / PPI / UPI."
 *
 * CARDS, PPI AND UPI. **eNACH / NACH is not named.** NACH is an NPCI system governed by
 * NPCI's own procedural guidelines, not by this direction. Our simulator carries three
 * rails - upi_autopay, card, and enach - so applying this framework's 24-hour rule to the
 * eNACH rail would be extending a regulation past its stated scope. The gate therefore
 * applies the pre-debit rule ONLY to the rails the direction names, and treats eNACH
 * pre-notification as an unsourced operational choice (see PRE_DEBIT_APPLICABLE_RAILS).
 * ================================================================================
 */
import type { Rail } from '../domain/types.ts';

export interface SourcedValue<T> {
  readonly id: string;
  readonly value: T;
  readonly unit: string;
  readonly source: string;
  readonly section: string;
  readonly quote: string;
  readonly retrievedOn: string;
}

function sourced<T>(
  id: string,
  value: T,
  unit: string,
  source: string,
  section: string,
  quote: string,
): SourcedValue<T> {
  return { id, value, unit, source, section, quote, retrievedOn: '2026-08-31' };
}

const FRAMEWORK_2026 =
  'RBI Digital Payments - E-mandate Framework, 2026 (RBI/DPSS/2026-27/396; ' +
  'RBI/CO.DPSS.POLC.No.S56/02.14.003/2026-27), dated 21 April 2026. ' +
  'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=13374';

export const RBI = {
  /** The pre-transaction notification must precede the charge by at least this long. */
  preDebitNotificationHours: sourced(
    'rbi.pre_debit_notification_hours',
    24,
    'hours',
    FRAMEWORK_2026,
    'Section 6',
    'An issuer shall send a pre-transaction notification to the customer, at least ' +
      '24 hours prior to the actual charge / debit.',
  ),

  /** Above this, a recurring transaction requires Additional Factor of Authentication. */
  afaThresholdPaise: sourced(
    'rbi.afa_threshold_paise',
    15_000_00,
    'paise (Rs 15,000)',
    FRAMEWORK_2026,
    'Section 8(a)',
    'All recurring transactions may be authorised without AFA up to Rs 15,000/- per ' +
      'transaction.',
  ),

  /**
   * Higher AFA-exempt ceiling for three named categories. A general subscription business
   * is not one of them, so the gate does NOT apply this ceiling - it is recorded because
   * omitting it would misrepresent the rule.
   */
  afaThresholdCategoryPaise: sourced(
    'rbi.afa_threshold_category_paise',
    1_00_000_00,
    'paise (Rs 1,00,000)',
    FRAMEWORK_2026,
    'Section 8(b)',
    'Payment of insurance premiums, subscription to mutual funds, and credit card bill ' +
      'payments may be made without AFA up to Rs 1,00,000/- per transaction.',
  ),
} as const;

/**
 * Rails the pre-debit notification rule is applied to.
 *
 * Exactly the rails Section 2 names, minus PPI which this project does not model.
 * eNACH is deliberately absent - see the scope note above.
 */
export const PRE_DEBIT_APPLICABLE_RAILS: ReadonlySet<Rail> = new Set<Rail>([
  'upi_autopay',
  'card',
]);

/**
 * WHAT THE FRAMEWORK DOES **NOT** SAY, RECORDED SO NOBODY LATER ASSUMES IT DOES.
 * -----------------------------------------------------------------------------
 * Section 6 requires notification "at least 24 hours prior to the actual charge / debit".
 * A retry is, on any ordinary reading, a charge. It is therefore tempting to conclude
 * that every retry needs its own 24-hour notice, and that this would make a next-day
 * retry impossible.
 *
 * WE CHECKED, AND THE DOCUMENT DOES NOT SAY THAT. Verified 2026-08-31: the framework
 * contains **no clause about retries, re-presentment, failed transactions, or declined
 * transactions at all**, and Section 6 does not state whether the notification is
 * per-mandate or per-transaction. The question is simply not addressed by the text.
 *
 * So this is UNRESOLVED AMBIGUITY, not a discovered non-compliance. An earlier draft of
 * this project claimed the strict reading would render the incumbent's documented T+3
 * cycle "non-compliant on its face". That was our inference stated as a finding, and it
 * has been withdrawn.
 *
 * Both readings are implemented as an OPERATIONAL POLICY CHOICE, defaulting to the
 * permissive one. Neither is presented as what the regulation requires:
 *
 *   'per_cycle'  (DEFAULT) one notification covers the cycle's scheduled debit and the
 *                retries that follow it. Consistent with published industry behaviour.
 *   'per_debit'  a conservative posture in which each charge carries its own aged notice.
 *                Available for an operator who wants the stricter stance; NOT a claim
 *                that the regulation demands it.
 *
 * Run with SALVAGE_PREDEBIT_SCOPE=per_debit to see what the conservative posture costs.
 * A definitive answer needs Razorpay's compliance team or a clarification from RBI.
 */
export type PreDebitScope = 'per_cycle' | 'per_debit';

export function preDebitScope(): PreDebitScope {
  return process.env.SALVAGE_PREDEBIT_SCOPE === 'per_debit' ? 'per_debit' : 'per_cycle';
}

/**
 * OPERATIONAL POLICY, NOT REGULATION.
 * -----------------------------------
 * The quiet-hours window below is OUR OWN choice. We have not found a payments regulation
 * that sets contact hours for payment-failure notifications, and inventing one and
 * labelling it "RBI" would be exactly the failure spec rule 1 describes. It is a
 * conventional daytime window, stated as a business policy.
 */
export const CONTACT_POLICY = {
  quietHoursStartIst: 21, // no outbound contact from 21:00 IST
  quietHoursEndIst: 9, //    ...until 09:00 IST
  maxContactsPerRollingWindow: 2,
  rollingWindowHours: 48,
  maxContactsPerCase: 4,
} as const;

/**
 * Fixed-date Indian national holidays. These three are gazetted nationwide and are not in
 * dispute. A production system needs a maintained calendar including state holidays and
 * the many date-varying festivals; this is a deliberate, stated subset rather than a
 * pretence of completeness.
 */
export const NATIONAL_HOLIDAYS_MMDD: ReadonlySet<string> = new Set([
  '01-26', // Republic Day
  '08-15', // Independence Day
  '10-02', // Gandhi Jayanti
]);

export const ALL_SOURCED_VALUES: ReadonlyArray<SourcedValue<unknown>> = Object.values(RBI);
