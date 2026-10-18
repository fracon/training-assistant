'use strict';
const {planFor}=require('./cycle-planning.cjs');
// Synthetic equivalent of the observed scale error; no provider/athlete content.
function incompatiblePlan(context) {
  const plan=planFor(context);
  plan.phases[0].intensity='Corrida leve com RPE aproximado de 2–4/10.';
  return plan;
}
module.exports={incompatiblePlan};
