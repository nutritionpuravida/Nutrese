import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function mustContain(snippet, label = snippet) {
  assert.ok(html.includes(snippet), `Missing expected planning-safety source: ${label}`);
}

function functionBody(name) {
  const start = html.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `Missing function ${name}`);
  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === '{') {
      depth += 1;
      seenBrace = true;
    } else if (ch === '}') {
      depth -= 1;
      if (seenBrace && depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract function body for ${name}`);
}

// Diet-type source coverage: these were the observed gaps that allowed
// prohibited foods into pescatarian/vegetarian/vegan rendered plans.
[
  'LUN_CHICKEN_QUINOA',
  'DIN_CHICKEN_QUINOA',
  'DIN_GEMISTA_LIGHT',
  'DIN_CHICKEN_MEATBALLS_RICE',
  'DIN_CHICKEN_MINCE_PASTA'
].forEach(key => mustContain(`'${key}'`, `meat exclusion key ${key}`));

[
  'BRK_BOILED_EGGS_2',
  'BRK_RUSKS_ANTHOTYRO',
  'BRK_YOGURT_HONEY_WALNUTS',
  'LUN_SPINACH_RICE',
  'DIN_OMELETTE'
].forEach(key => mustContain(`'${key}'`, `vegan animal-derived exclusion key ${key}`));

mustContain('function dietRestrictionReasonsForText', 'AI/rendered text diet validator');
mustContain('function validateAiMealPlanForDiet', 'AI diet validator');
mustContain('function validateAiMealPlanVisibleOil', 'AI visible-oil validator');
mustContain('return options.filter(o=>mealAllowedForDiet(o.v, dietType));', 'dropdowns filter through mealAllowedForDiet');

const applyAi = functionBody('applyAiSevenDayPlan');
assert.match(applyAi, /validateAiMealPlanForDiet\(plan,\s*dietType\)/, 'AI plans must be diet-validated before storage');
assert.match(applyAi, /validateAiMealPlanVisibleOil\(plan,\s*caps\)/, 'AI plans must be visible-oil validated before storage');
assert.match(applyAi, /enforceWeekPlanDietCompatibility\(dietType\)/, 'AI plans must pass final week compatibility guard');

const updateWeek = functionBody('updateWeekPlan');
assert.match(updateWeek, /firstCompatibleMealKey\(optionMap\[mealKey\],\s*value,\s*diet,\s*fallback\)/, 'manual week dropdown changes must be diet-safe');

const applyTemplate = functionBody('applyMealPlanTemplate');
assert.match(applyTemplate, /firstCompatibleMealKey\(BREAKFAST_OPTIONS,\s*picked\.brk,\s*templateDiet/, 'template breakfast must be diet-safe');
assert.match(applyTemplate, /firstCompatibleMealKey\(LUNCH_OPTIONS,\s*picked\.lun,\s*templateDiet/, 'template lunch must be diet-safe');
assert.match(applyTemplate, /firstCompatibleMealKey\(DINNER_OPTIONS,\s*picked\.din,\s*templateDiet/, 'template dinner must be diet-safe');
assert.match(applyTemplate, /enforceWeekPlanDietCompatibility\(templateDiet\)/, 'template must pass final week compatibility guard');

const ensureWeek = functionBody('ensureWeekPlans');
assert.match(ensureWeek, /enforceWeekPlanDietCompatibility\(v\('p-diet'\)\|\|S\.dietType\|\|'Omnivore'\)/, 'week normalization must enforce diet compatibility');

const allocateFat = functionBody('allocateFatRemaining');
assert.doesNotMatch(
  allocateFat,
  /portions\[slot\]\.fat\s*=\s*\(portions\[slot\]\.fat\|\|0\)\s*\+\s*remaining/,
  'allocateFatRemaining must not force all remaining fat above the per-meal cap'
);
assert.match(allocateFat, /Fat target exceeds the \$\{maxPerMeal\} tsp olive-oil per-meal cap/, 'unallocated capped fat must create a warning');

const calcPlan = functionBody('calcDayTotalsForPlan');
assert.match(calcPlan, /visibleOilCap=Number\(caps\?\.fatPerMealMax\|\|6\)/, 'displayed oil cap must come from effective caps');
assert.match(calcPlan, /slotCanAddOil/, 'calorie reconciliation must check whether a slot can accept visible oil');
assert.match(calcPlan, /below target after realistic visible-oil allocation/, 'unresolved calorie gap must be reported rather than hidden with excess oil');

const calcDisplay = functionBody('calcDayTotalsForPlanDisplay');
assert.match(calcDisplay, /Number\(slots\.lun\.fat\|\|0\)>=visibleOilCap/, 'strict display reconciliation must respect lunch oil cap');
assert.match(calcDisplay, /Number\(slots\.din\.fat\|\|0\)>=visibleOilCap/, 'strict display reconciliation must respect dinner oil cap');

console.log('Planning-safety static checks passed.');
