import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..', '..');
const indexPath = path.join(root, 'index.html');
const tracesDir = path.join(root, 'tests', 'planning-safety', 'traces');

function requirePlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch (_err) {
    const bundled = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules');
    return createRequire(path.join(bundled, 'planning-safety-loader.js'))('playwright');
  }
}

function loadAppHtml() {
  const raw = fs.readFileSync(indexPath, 'utf8');
  return raw.replace(
    /<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\/dist\/umd\/supabase\.min\.js"><\/script>/,
    `<script>
window.supabase={createClient:function(){const r={data:null,error:null};const c={select(){return c},insert(){return c},update(){return c},upsert(){return c},delete(){return c},eq(){return c},order(){return c},limit(){return c},maybeSingle(){return Promise.resolve(r)},single(){return Promise.resolve(r)},then(resolve){return Promise.resolve({data:[],error:null}).then(resolve)}};return{auth:{onAuthStateChange(cb){setTimeout(()=>cb('SIGNED_OUT',null),0);return{data:{subscription:{unsubscribe(){}}}}},getSession(){return Promise.resolve({data:{session:null},error:null})},getUser(){return Promise.resolve({data:{user:null},error:null})}},from(){return c},functions:{invoke(){return Promise.resolve({data:null,error:{message:'stubbed'}})}}}}};
window.Stripe=function(){return{redirectToCheckout(){return Promise.resolve({})}}};
</script>`
  );
}

const prohibited = {
  Pescatarian: /\b(chicken|pork|beef|turkey|mince|burger|meatball|souvlaki)\b|κοτόπουλ|χοιριν|μοσχ|γαλοπούλ|κιμά|μπιφτέκ|κεφτεδ|σουβλάκ/i,
  Vegetarian: /\b(chicken|pork|beef|turkey|mince|burger|meatball|souvlaki|fish|salmon|tuna|sea bream|sea bass)\b|κοτόπουλ|χοιριν|μοσχ|γαλοπούλ|κιμά|μπιφτέκ|κεφτεδ|σουβλάκ|ψάρι|σολομ|τόν|τσιπούρ|λαβράκ/i,
  Vegan: /\b(chicken|pork|beef|turkey|mince|burger|meatball|souvlaki|fish|salmon|tuna|sea bream|sea bass|egg|eggs|yogurt|cheese|halloumi|ricotta|milk|honey)\b|κοτόπουλ|χοιριν|μοσχ|γαλοπούλ|κιμά|μπιφτέκ|κεφτεδ|σουβλάκ|ψάρι|σολομ|τόν|τσιπούρ|λαβράκ|αυγ|γιαούρ|τυρί|χαλούμ|ανθότυρ|γάλα|μέλι/i
};

async function withPage(fn) {
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.setContent(loadAppHtml(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => typeof buildSevenDay === 'function' && typeof calcDayTotalsForPlanDisplay === 'function', null, { timeout: 10000 });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function setSyntheticProfile(page, { diet = 'Omnivore', targetKcal = 2037, fat = 12 } = {}) {
  await page.evaluate(({ diet, targetKcal, fat }) => {
    resetForm();
    S.goalKcal = targetKcal;
    S.ex = { fruit: 2, veg: 6, dairy: 2, starch: 8, protein: 8, fat };
    S.exAuto = { starch: false, protein: false, fat: false };
    S.exMeta = makeExMeta();
    const dietEl = document.getElementById('p-diet');
    if (dietEl) dietEl.value = diet;
    S.dietType = diet;
    S.mealLanguage = 'EN';
    S.sevenDayView = 'week';
  }, { diet, targetKcal, fat });
}

async function capturePlan(page, label) {
  const data = await page.evaluate(() => {
    buildSevenDay();
    const text = document.getElementById('sevenday-body')?.innerText || '';
    const rows = (S.weekPlans || []).map((plan, index) => {
      const en = calcDayTotalsForPlanDisplay(plan, 'EN', index);
      const gr = calcDayTotalsForPlanDisplay(plan, 'GR', index);
      return {
        index,
        keys: { brk: plan.brk, lun: plan.lun, din: plan.din },
        oilBalance: en.oilBalance || {},
        portions: en.portions || {},
        totals: { en, gr },
        rendered: {
          en: {
            brk: getSevenDaySlotData(plan, en, 'brk', 'EN', index).text,
            lun: getSevenDaySlotData(plan, en, 'lun', 'EN', index).text,
            din: getSevenDaySlotData(plan, en, 'din', 'EN', index).text
          },
          gr: {
            brk: getSevenDaySlotData(plan, gr, 'brk', 'GR', index).text,
            lun: getSevenDaySlotData(plan, gr, 'lun', 'GR', index).text,
            din: getSevenDaySlotData(plan, gr, 'din', 'GR', index).text
          }
        },
        warnings: en.warnings || []
      };
    });
    return {
      label,
      inputs: { diet: S.dietType, goalKcal: S.goalKcal, exchanges: S.ex },
      candidateMeals: {
        breakfast: filteredMealOptions(BREAKFAST_OPTIONS, S.dietType).map(o => o.v),
        lunch: filteredMealOptions(LUNCH_OPTIONS, S.dietType).map(o => o.v),
        dinner: filteredMealOptions(DINNER_OPTIONS, S.dietType).map(o => o.v)
      },
      selectedMeals: rows.map(r => r.keys),
      slotAllocations: rows.map(r => r.portions),
      renderedPortions: rows.map(r => r.rendered),
      calculatedTotals: rows.map(r => r.totals.en.totalKcal),
      warnings: rows.flatMap(r => r.warnings),
      text
    };
  });
  fs.mkdirSync(tracesDir, { recursive: true });
  fs.writeFileSync(path.join(tracesDir, `${label}.trace.json`), JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}

function assertNoProhibitedText(diet, text, message) {
  assert.ok(!prohibited[diet].test(text), `${message}: prohibited ${diet} text found`);
}

function assertNoExcessOil(text, cap = 6) {
  const matches = [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*(?:tsp olive oil|κ\.γ\. ελαιόλαδο)/gi)];
  for (const match of matches) {
    assert.ok(Number(match[1]) <= cap, `visible oil exceeds ${cap} tsp: ${match[0]}`);
  }
}

await withPage(async page => {
  const dietTemplateKeys = { Pescatarian: 'Pescatarian', Vegetarian: 'Vegetarian' };
  for (const [diet, templateKey] of Object.entries(dietTemplateKeys)) {
    await setSyntheticProfile(page, { diet, targetKcal: 2037, fat: 12 });
    await page.evaluate(templateKey => applyMealPlanTemplate(templateKey), templateKey);
    const captured = await capturePlan(page, `${diet.toLowerCase()}_template`);
    assertNoProhibitedText(diet, captured.text, `${diet} template rendered plan`);
    assertNoExcessOil(captured.text);
  }

  await setSyntheticProfile(page, { diet: 'Pescatarian', targetKcal: 2037, fat: 12 });
  await page.evaluate(() => {
    S.weekPlans = WEEK_PLANS.map(p => ({ ...p }));
    S.weekPlans[0].lun = 'LUN_CHICKEN_RICE';
    S.weekPlans[0].din = 'DIN_BIFTEKI_BULGUR';
    buildSevenDay();
  });
  const defaultPesc = await capturePlan(page, 'pescatarian_default_manual_suggestions');
  assertNoProhibitedText('Pescatarian', defaultPesc.text, 'pescatarian default/manual rendered plan');

  await setSyntheticProfile(page, { diet: 'Vegan', targetKcal: 1800, fat: 8 });
  await page.evaluate(() => {
    S.weekPlans = WEEK_PLANS.map(p => ({ ...p }));
    buildSevenDay();
  });
  const vegan = await capturePlan(page, 'vegan_default');
  assertNoProhibitedText('Vegan', vegan.text, 'vegan rendered plan');

  await setSyntheticProfile(page, { diet: 'Pescatarian', targetKcal: 2037, fat: 12 });
  const oilCase = await capturePlan(page, 'unrealistic_oil_case');
  assertNoExcessOil(oilCase.text);
  assert.ok(!/\b(?:1[0-9]|[2-9][0-9])\s*tsp olive oil\b/i.test(oilCase.text), 'calorie gap must not be solved by 10+ tsp visible oil');

  const reconciliation = oilCase.calculatedTotals.every(total => Number.isFinite(total));
  assert.ok(reconciliation, 'all generated days must have numeric totals');

  const aiBad = {
    monday: {
      lunch: { name: 'Chicken rice', description_en: 'Chicken + rice + 12 tsp olive oil', description_gr: 'Κοτόπουλο + ρύζι + 12 κ.γ. ελαιόλαδο', kcal: 900 }
    }
  };
  await assert.rejects(
    page.evaluate(plan => {
      S.dietType = 'Pescatarian';
      return applyAiSevenDayPlan(plan);
    }, aiBad),
    /diet|prohibited|oil|realism/i,
    'AI-generated selections with prohibited foods or excessive oil must be rejected before rendering'
  );
});

console.log('Planning Safety Batch 1 regression checks passed.');
