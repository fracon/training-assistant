'use strict';
// Bounded textual guard, not a language/clinical interpreter. Only numbers tied
// directly to an explicit effort-scale label are examined; other units stay intact.
const NUMBER = '-?\\d+(?:[.,]\\d+)?(?!\\d|[.,]\\d)';
const OTHER_UNIT = '(?!\\s*(?:%|(?:km|mi|bpm|min|minutes?|minutos?|seconds?|segundos?)\\b))';
const LABEL = '(?:rpe|esforco\\s+percebido|percepcao\\s+(?:subjetiva\\s+)?d[oe]\\s+esforco|perceived\\s+(?:exertion|effort)|escala\\s+de\\s+esforco|effort\\s+scale)';
const PREFIX = '(?:\\s*(?:[=:()<>≤≥\\[\\]]|\\b(?:de|of|em|na|on|a|the|escala|scale|entre|between|at|alvo|target|score|rating|valor|ate|up\\s+to|about|around|aproximado|aproximada|aproximadamente|approximately|roughly|cerca\\s+de)\\b)){0,8}\\s*';
const READING = `(${NUMBER})(?:\\s*(?:[–—−-]|\\b(?:a|ate|to|through|e|and)\\b)\\s*(${NUMBER})${OTHER_UNIT})?(?:\\s+(?:pontos?|points?))?(?:\\s*(?:/|\\b(?:de|em|out\\s+of|on\\s+a\\s+scale\\s+of|numa\\s+escala\\s+de)\\b)\\s*(${NUMBER}))?`;
const forward = new RegExp(`\\b${LABEL}\\b${PREFIX}${READING}`, 'giu');
const reverse = new RegExp(`(?<![\\d.,/–—−:-])${READING}\\s+(?:de\\s+|of\\s+)?${LABEL}\\b(?!${PREFIX}(?:${NUMBER}|/\\s*${NUMBER}))`, 'giu');
const scaleSuffix = new RegExp(`\\b${LABEL}\\b${PREFIX}${READING}\\s*\\(\\s*(?:escala|scale)(?:\\s+(?:de|of|from))?\\s+(${NUMBER})(?:\\s*(?:[–—−-]|a|to)\\s*(${NUMBER}))?\\s*\\)`, 'giu');
const explicitEffort = new RegExp(`\\b(?:esforco|effort)\\b${PREFIX}${READING}`, 'giu');
const denominator = new RegExp(`\\b${LABEL}\\b${PREFIX}/\\s*(${NUMBER})`, 'giu');
function incompatibleRpe(text) {
  // Normalize only a matching copy; persisted/displayed content is never rewritten.
  text=text.normalize('NFKD').replace(/\p{M}/gu, '');
  for (const match of text.matchAll(denominator)) if (numeric(match[1]) !== 5) return true;
  for (const match of text.matchAll(scaleSuffix)) {
    const start=numeric(match[4]);
    if (match[5] === undefined ? start !== 5 : start !== 1 || numeric(match[5]) !== 5) return true;
  }
  for (const [pattern, needsDenominator] of [[forward,false], [reverse,false], [explicitEffort,true]]) for (const match of text.matchAll(pattern)) {
    if (needsDenominator && match[3] === undefined) continue;
    for (const value of match.slice(1, 3)) if (value !== undefined && (numeric(value) < 1 || numeric(value) > 5)) return true;
    if (match[3] !== undefined && numeric(match[3]) !== 5) return true;
  }
  return false;
}
function numeric(value) { return Number(value.replace(',', '.')); }
module.exports = { incompatibleRpe };
