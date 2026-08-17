/**
 * @typedef {object} PaymentRail
 * @property {string} mode "demo" or a production rail identifier.
 * @property {(walletAddress: string) => Promise<bigint>} getBalance
 * @property {(walletAddress: string) => Promise<bigint>} getDailySpend
 * @property {(offer: object) => Promise<object>} createAuthorization Demo/client-side use only.
 * @property {(authorization: object) => Promise<boolean>} verifyAuthorization
 * @property {(request: {session: object, authorization: object, amountAtomic: bigint, idempotencyKey: string}) => Promise<object>} settle
 */

// This module intentionally exports no generic implementation. A production
// adapter must delegate signature verification and settlement to its selected
// x402 facilitator/payment provider, and must return a durable provider payment
// reference. See docs/PRODUCTION.md.
export const PAYMENT_RAIL_CONTRACT_VERSION = 1;
