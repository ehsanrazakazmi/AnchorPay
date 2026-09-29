// API shapes: public Transfer (contracts: public-api.yaml#/components/schemas/Transfer) and InternalTransfer.
import type { Recipient } from '../ports.ts';
import { receiveAmount, sendAmount, totalCharge, type HistoryRow, type TransferRow } from './transfers.ts';

/** Customer-facing explanations. Compliance failures never reveal why (sanctions/AML details stay internal). */
export const FAILURE_MESSAGES: Record<string, string> = {
  QUOTE_EXPIRED: 'The price expired before the transfer was set up. You were not charged. Please start again.',
  RATE_LOCK_FAILED: "We couldn't lock the exchange rate. You were not charged. Please try again.",
  RATE_LOCK_EXPIRED: 'The 30-minute rate lock expired before your payment was confirmed. You were not charged.',
  PAYMENT_DECLINED: 'Your payment was declined. You were not charged.',
  PAYMENT_UNAVAILABLE: "We couldn't reach the payment provider. You were not charged. Please try again.",
  PAYMENT_NOT_STARTED: "The payment wasn't started in time. You were not charged.",
  CAPTURE_FAILED: "We couldn't collect your payment. You were not charged.",
  COMPLIANCE_BLOCKED: "We can't process this transfer. You were not charged. Contact support if you have questions.",
  COMPLIANCE_REJECTED: "We can't process this transfer. You were not charged. Contact support if you have questions.",
  PAYOUT_FAILED: "We couldn't deliver the money to your recipient. Your payment is being refunded to your original payment method.",
  SETUP_INCOMPLETE: "The transfer couldn't be set up. You were not charged. Please try again.",
};

export interface RecipientSummary {
  id: string;
  fullName: string;
  payoutMethod: 'bank_account' | 'mobile_wallet';
  destinationMasked: string;
}

export function summarise(r: Recipient): RecipientSummary {
  const destinationMasked = r.payoutMethod === 'bank_account'
    ? `${r.bankAccount?.bankName ?? 'Bank'} ${r.bankAccount?.accountNumberMasked ?? ''}`.trim()
    : `${r.mobileWallet?.provider === 'jazzcash' ? 'JazzCash' : 'Easypaisa'} ${r.mobileWallet?.walletNumberMasked ?? ''}`.trim();
  return { id: r.id, fullName: r.fullName, payoutMethod: r.payoutMethod, destinationMasked };
}

/** Used if identity-service can't be reached: tracking must keep working. */
export function unknownRecipient(t: TransferRow): RecipientSummary {
  return { id: t.recipient_id, fullName: 'Your recipient', payoutMethod: t.payout_method ?? 'bank_account', destinationMasked: '' };
}

function allowedActions(t: TransferRow): string[] {
  const collecting = t.collect_requested_at !== null;
  if (t.status === 'FX_LOCKED') return ['authorize_payment', 'cancel'];
  if (t.status === 'ON_HOLD' && !collecting) return ['cancel'];
  if (t.status === 'AWAITING_RECONFIRM' && !collecting) return ['reconfirm', 'cancel'];
  return [];
}

const money = (amountMinor: number, currency: string) => ({ amountMinor, currency: currency.trim() });

export function toApi(t: TransferRow, recipient: RecipientSummary, timeline: HistoryRow[]) {
  const receive = receiveAmount(t);
  const failureCode = t.failure_code;
  return {
    id: t.id,
    reference: t.reference,
    status: t.status,
    corridorCode: t.corridor_code,
    recipient,
    fundingMethod: t.funding_method,
    purpose: t.purpose,
    sendAmount: sendAmount(t),
    fee: money(t.fee_minor, t.send_currency),
    cardSurcharge: money(t.card_surcharge_minor, t.send_currency),
    totalCharge: totalCharge(t),
    ...(receive ? { receiveAmount: receive } : {}),
    ...(t.mid_rate ? { midRate: t.mid_rate } : {}),
    ...(t.offer_rate ? { offerRate: t.offer_rate } : {}),
    ...(t.rate_lock_expires_at ? { rateLockExpiresAt: t.rate_lock_expires_at.toISOString() } : {}),
    ...(t.delivery_estimate ? { deliveryEstimate: t.delivery_estimate } : {}),
    ...(failureCode && (t.status === 'FAILED' || t.status === 'REFUNDED')
      ? { failure: { code: failureCode, message: FAILURE_MESSAGES[failureCode] ?? 'Something went wrong with this transfer.' } }
      : {}),
    ...(t.cancel_reason ? { cancelReason: t.cancel_reason } : {}),
    allowedActions: allowedActions(t),
    timeline: timeline.map((h) => ({ status: h.to_status, at: h.created_at.toISOString() })),
    createdAt: t.created_at.toISOString(),
    updatedAt: t.updated_at.toISOString(),
    ...(t.completed_at ? { completedAt: t.completed_at.toISOString() } : {}),
  };
}

export function toInternal(t: TransferRow) {
  const receive = receiveAmount(t);
  return {
    id: t.id,
    reference: t.reference,
    userId: t.user_id,
    recipientId: t.recipient_id,
    status: t.status,
    corridorCode: t.corridor_code,
    fundingMethod: t.funding_method,
    purpose: t.purpose,
    sendAmount: sendAmount(t),
    fee: money(t.fee_minor, t.send_currency),
    cardSurcharge: money(t.card_surcharge_minor, t.send_currency),
    totalCharge: totalCharge(t),
    ...(receive ? { receiveAmount: receive } : {}),
    ...(t.mid_rate ? { midRate: t.mid_rate } : {}),
    ...(t.offer_rate ? { offerRate: t.offer_rate } : {}),
    ...(t.fx_lock_id ? { fxLockId: t.fx_lock_id } : {}),
    ...(t.payment_id ? { paymentId: t.payment_id } : {}),
    ...(t.payout_id ? { payoutId: t.payout_id } : {}),
    createdAt: t.created_at.toISOString(),
    updatedAt: t.updated_at.toISOString(),
  };
}
