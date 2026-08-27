import { test, expect } from "bun:test";
import { isStripeServerKey } from "../stripe-webhook.js";

test("isStripeServerKey accepts Stripe secret and restricted keys only", () => {
  expect(isStripeServerKey("sk_live_example")).toBe(true);
  expect(isStripeServerKey("sk_test_example")).toBe(true);
  expect(isStripeServerKey("rk_live_example")).toBe(true);
  expect(isStripeServerKey("rk_test_example")).toBe(true);
  expect(isStripeServerKey("pk_live_example")).toBe(false);
  expect(isStripeServerKey("whsec_example")).toBe(false);
  expect(isStripeServerKey("rk_other_example")).toBe(false);
  expect(isStripeServerKey("   ")).toBe(false);
  expect(isStripeServerKey(null)).toBe(false);
});
