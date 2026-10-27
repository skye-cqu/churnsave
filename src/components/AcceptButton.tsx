"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Buyer-facing one-click accept: creates + captures the discounted PayPal order. */
export function AcceptButton({ token }: { token: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function accept() {
    setState("working");
    try {
      const res = await fetch(`/api/offers/${token}/accept`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setState("error");
        setMessage(data.error ?? "Something went wrong");
        return;
      }
      setState("done");
      setMessage(
        `Payment captured (order ${data.orderId}). You saved money — your subscription stays active.`,
      );
      router.refresh();
    } catch (err) {
      setState("error");
      setMessage(String(err));
    }
  }

  return (
    <div className="space-y-3">
      <button onClick={accept} disabled={state !== "idle"} className="btn-primary w-full py-3 text-base">
        {state === "working" ? "Processing payment..." : "Accept offer & keep my subscription"}
      </button>
      {message && (
        <p className={`text-sm ${state === "error" ? "text-red-400" : "text-emerald-400"}`}>
          {message}
        </p>
      )}
    </div>
  );
}
