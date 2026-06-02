import { asNumber, copyPosition, positionKey } from "../path/grid-utils.js";

function readRuleEntry(source, key) {
  if (!source) return null;
  if (source instanceof Map) return source.get(key) ?? null;
  if (typeof source === "object") return source[key] ?? null;
  return null;
}

function tileRuleEntryAt(source, position) {
  const key = positionKey(copyPosition(position));
  return readRuleEntry(source, key);
}

function countRuleEntryFor(source, count) {
  const normalizedCount = Math.round(Number(count));
  if (!Number.isFinite(normalizedCount) || normalizedCount < 1) return null;
  return readRuleEntry(source, String(normalizedCount));
}

function numericValue(entry, field, fallback) {
  if (entry === null || entry === undefined) return fallback;
  const value = asNumber(entry?.[field] ?? entry, fallback);
  return Number.isFinite(value) ? value : fallback;
}

function normalizedDeliveryValueThresholdRule(state) {
  const rule = state?.deliveryValueThresholdRule;
  if (!rule || typeof rule !== "object") return null;
  const comparison = String(rule.comparison ?? "").trim().toLowerCase();
  const threshold = asNumber(rule.threshold, NaN);
  const multiplier = asNumber(rule.multiplier, NaN);
  if (!["gt", "lt"].includes(comparison)) return null;
  if (!Number.isFinite(threshold)) return null;
  if (!Number.isFinite(multiplier) || multiplier < 0) return null;
  return { comparison, threshold, multiplier };
}

export function pickupMultiplierAt(state, position) {
  return numericValue(tileRuleEntryAt(state?.pickupTileMultipliers, position), "multiplier", 1);
}

export function pickupBonusAt(state, position) {
  return numericValue(tileRuleEntryAt(state?.pickupTileBonuses, position), "bonus", 0);
}

export function deliveryMultiplierAt(state, position) {
  return numericValue(tileRuleEntryAt(state?.deliveryTileMultipliers, position), "multiplier", 1);
}

export function deliveryBonusAt(state, position) {
  return numericValue(tileRuleEntryAt(state?.deliveryTileBonuses, position), "bonus", 0);
}

export function deliveryCountMultiplierAt(state, count) {
  const normalizedCount = Math.round(Number(count));
  if (!Number.isFinite(normalizedCount) || normalizedCount < 1) return 1;
  return numericValue(countRuleEntryFor(state?.deliveryCountMultipliers, normalizedCount), "multiplier", 1);
}

export function deliveryCountBonusAt(state, count) {
  const normalizedCount = Math.round(Number(count));
  if (!Number.isFinite(normalizedCount) || normalizedCount < 1) return 0;
  return numericValue(countRuleEntryFor(state?.deliveryCountBonuses, normalizedCount), "bonus", 0);
}

export function adjustDeliveredParcelBaseValue(baseDeliveredValue, state, overrides = {}) {
  const normalizedBase = Math.max(0, asNumber(baseDeliveredValue, 0));
  const rule = overrides.rule ?? normalizedDeliveryValueThresholdRule(state);
  if (!rule) return normalizedBase;

  const matches = rule.comparison === "gt"
    ? normalizedBase > rule.threshold
    : normalizedBase < rule.threshold;
  return matches ? normalizedBase * rule.multiplier : normalizedBase;
}

export function estimateDeliveredValueForSinglePackage({
  deliveredBaseValue,
  state,
  deliveryPosition,
  count = 1,
  ruleOverrides = {},
  deliveryOverrides = {}
}) {
  const adjustedParcelValue = adjustDeliveredParcelBaseValue(deliveredBaseValue, state, ruleOverrides);
  return adjustDeliveredBaseValue(adjustedParcelValue, state, deliveryPosition, count, deliveryOverrides);
}

export function adjustPickupBaseValue(baseValue, state, position, overrides = {}) {
  const normalizedBase = Math.max(0, asNumber(baseValue, 0));
  const multiplier =
    overrides.multiplier !== undefined ? asNumber(overrides.multiplier, 1) : pickupMultiplierAt(state, position);
  const bonus = overrides.bonus !== undefined ? asNumber(overrides.bonus, 0) : pickupBonusAt(state, position);
  return normalizedBase * multiplier + bonus;
}

export function adjustDeliveredBaseValue(baseDeliveredValue, state, deliveryPosition, count, overrides = {}) {
  const normalizedBase = asNumber(baseDeliveredValue, 0);
  const deliveryMultiplier =
    overrides.deliveryMultiplier !== undefined
      ? asNumber(overrides.deliveryMultiplier, 1)
      : deliveryMultiplierAt(state, deliveryPosition);
  const countMultiplier =
    overrides.countMultiplier !== undefined
      ? asNumber(overrides.countMultiplier, 1)
      : deliveryCountMultiplierAt(state, count);
  const deliveryBonus =
    overrides.deliveryBonus !== undefined
      ? asNumber(overrides.deliveryBonus, 0)
      : deliveryBonusAt(state, deliveryPosition);
  const countBonus =
    overrides.countBonus !== undefined ? asNumber(overrides.countBonus, 0) : deliveryCountBonusAt(state, count);
  return normalizedBase * deliveryMultiplier * countMultiplier + deliveryBonus + countBonus;
}
