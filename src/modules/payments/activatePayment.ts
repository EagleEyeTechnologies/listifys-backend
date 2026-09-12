import { Payment } from "./payment.model.js";
import { activateBoostFromPayment, markBoostRefunded } from "../boost/boost.service.js";
import {
  activatePremiumFromPayment,
  markPremiumRefunded,
} from "../premium/premium.service.js";
import {
  activateEventBookingFromPayment,
  markEventTicketRefunded,
} from "../event-tickets/eventTickets.service.js";
import { AppError } from "../../utils/AppError.js";

export async function activateForPayment(paymentId: string) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw new AppError(404, "Payment not found", "NOT_FOUND");

  if (payment.purpose === "premium_subscription") {
    const result = await activatePremiumFromPayment(paymentId);
    return {
      payment: result.payment,
      already: result.already,
      kind: "premium" as const,
      campaignId: null as string | null,
      subscriptionId: result.subscription?._id.toString() || null,
      bookingId: null as string | null,
      status: result.subscription?.status || result.payment.status,
    };
  }

  if (payment.purpose === "event_ticket") {
    const result = await activateEventBookingFromPayment(paymentId);
    return {
      payment: result.payment,
      already: result.already,
      kind: "event_ticket" as const,
      campaignId: null as string | null,
      subscriptionId: null as string | null,
      bookingId: result.booking?._id.toString() || null,
      status: result.booking?.status || result.payment.status,
    };
  }

  const result = await activateBoostFromPayment(paymentId);
  return {
    payment: result.payment,
    already: result.already,
    kind: "boost" as const,
    campaignId: result.campaign?._id.toString() || null,
    subscriptionId: null as string | null,
    bookingId: null as string | null,
    status: result.campaign?.status || result.payment.status,
  };
}

export async function refundForPayment(paymentId: string) {
  const payment = await Payment.findById(paymentId);
  if (!payment) return;
  if (payment.purpose === "premium_subscription") {
    await markPremiumRefunded(paymentId);
    return;
  }
  if (payment.purpose === "event_ticket") {
    await markEventTicketRefunded(paymentId);
    return;
  }
  await markBoostRefunded(paymentId);
}
