import { acceptOffer, AcceptError } from "@/lib/recover";
import { getGateway, getStore } from "@/lib/runtime";

/** Buyer clicks "Accept offer" -> discounted PayPal order created + captured. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  try {
    const result = await acceptOffer(getStore(), getGateway(), token);
    return Response.json({
      accepted: true,
      orderId: result.orderId,
      orderStatus: result.orderStatus,
      amount: result.amount,
      monthlyMrr: result.monthlyMrr,
      currency: result.currency,
    });
  } catch (err) {
    if (err instanceof AcceptError) {
      return Response.json({ error: err.message }, { status: err.httpStatus });
    }
    return Response.json({ error: `accept failed: ${String(err)}` }, { status: 500 });
  }
}
