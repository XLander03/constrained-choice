import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAmbiguity } from "../src/route/ambiguity.ts";
import { IdentityCalibrator, IsotonicCalibrator, chooseThreshold } from "../src/route/calibrate.ts";
import { routeLine } from "../src/route/router.ts";
import { NONE } from "../src/types.ts";
import { cands, decision, line, sku } from "./helpers.ts";

const id = new IdentityCalibrator();
const policy = { threshold: 0.9, allowUnspecifiedUnit: false };
const maggi = cands(sku("SKU0034"), sku("SKU0033"), sku("SKU0035"), sku("SKU0036"));

test("clear pick above threshold is auto-accepted", () => {
  const r = routeLine(line({ raw: "maggi 70g 2 peti", sizeHint: { value: 70, unit: "g" } }), maggi, decision("SKU0034", 0.97), id, policy);
  assert.equal(r.route, "auto"); assert.equal(r.reason, "ok");
});

test("pack size not stated → review with the fitting packs, even at high confidence", () => {
  const r = routeLine(line({ raw: "maggi 2 peti" }), maggi, decision("SKU0034", 0.99), id, policy);
  assert.equal(r.route, "review"); assert.match(r.reason, /pack_size_ambiguous/);
  assert.deepEqual(new Set(r.ambiguousWith), new Set(["SKU0033", "SKU0034", "SKU0035", "SKU0036"]));
});

test("price hint that matches no pack ('maggi 70 wala') is ambiguous, not silently reinterpreted", () => {
  const r = checkAmbiguity(line({ raw: "maggi 70 wala", priceHint: 70 }), sku("SKU0034"), maggi);
  assert.equal(r.ambiguous, true);
});

test("variant not stated → variant_ambiguous; naming the variant resolves it", () => {
  const lux = cands(sku("SKU0091"), sku("SKU0093"), sku("SKU0092"), sku("SKU0094"));
  const vague = checkAmbiguity(line({ raw: "lux 100 gm", sizeHint: { value: 100, unit: "g" } }), sku("SKU0091"), lux);
  assert.deepEqual([vague.ambiguous, vague.kind], [true, "variant"]);
  const named = checkAmbiguity(line({ raw: "lux pink 100 gm", sizeHint: { value: 100, unit: "g" } }), sku("SKU0091"), lux);
  assert.equal(named.ambiguous, false);
});

test("hard rules: none_of_these, missing qty, unspecified unit, low confidence", () => {
  const l = line({ raw: "maggi 70g", sizeHint: { value: 70, unit: "g" } });
  assert.match(routeLine(l, maggi, decision(NONE, 0.99), id, policy).reason, /none_of_these/);
  assert.match(routeLine({ ...l, qty: null }, maggi, decision("SKU0034", 0.99), id, policy).reason, /qty_missing/);
  assert.match(routeLine({ ...l, unit: "unspecified" }, maggi, decision("SKU0034", 0.99), id, policy).reason, /unit_unspecified/);
  assert.equal(routeLine({ ...l, unit: "unspecified" }, maggi, decision("SKU0034", 0.99), id, { ...policy, allowUnspecifiedUnit: true }).route, "auto");
  assert.match(routeLine(l, maggi, decision("SKU0034", 0.5), id, policy).reason, /low_confidence/);
});

test("isotonic calibration is monotone and threshold picks max coverage at target precision", () => {
  const samples = [...Array(40)].map((_, i) => ({ conf: 0.5 + i / 80, correct: i >= 8 }));
  const cal = new IsotonicCalibrator(); cal.fit(samples);
  assert.ok(cal.apply(0.55) <= cal.apply(0.8) && cal.apply(0.8) <= cal.apply(0.99));
  const t = chooseThreshold(samples, 0.98);
  assert.ok(t.precision >= 0.98); assert.equal(t.coverage, 32 / 40);
  const back = IsotonicCalibrator.fromJSON(cal.toJSON());
  assert.equal(back.apply(0.7), cal.apply(0.7));
});

test("isotonic calibrator sends confidences below the fitted range to review instead of extrapolating", () => {
  const cal = new IsotonicCalibrator();
  cal.fit([{ conf: 0.6, correct: true }, { conf: 0.8, correct: true }, { conf: 0.95, correct: true }]);
  assert.equal(cal.apply(0.7), 1);
  assert.equal(cal.apply(0.3), 0);
  const back = IsotonicCalibrator.fromJSON(cal.toJSON());
  assert.equal(back.apply(0.3), 0);
  assert.equal(back.minConfSeen, 0.6);
  // calibration files written before M4 have no min_conf_seen and keep their old behaviour
  const legacy = IsotonicCalibrator.fromJSON({ xs: [0.6, 0.95], ys: [1, 1] });
  assert.equal(legacy.apply(0.3), 1);
});
