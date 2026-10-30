import { createFuzzyMatcher, createFuzzySearchIndex } from "./fuzzySearch.js";

const normalize = (value) =>
  String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

export function createSkillSearchIndex(skills) {
  return createFuzzySearchIndex(skills).map((entry) => ({
    ...entry,
    name: normalize(entry.item.split(".").pop()),
    nameValues: createFuzzySearchIndex([entry.item.split(".").pop()])[0].values,
  }));
}

function literalScore(values, terms) {
  let score = 0;
  for (const term of terms) {
    let best = Infinity;
    for (const value of values) {
      if (value === term) {
        best = 0;
        break;
      }
      if (value.startsWith(term)) best = Math.min(best, 1);
      else if (value.includes(term)) best = Math.min(best, 2);
    }
    if (best === Infinity) return null;
    score = Math.max(score, best);
  }
  return score;
}

export function rankSkillSearch(index, searchText, descriptions = {}) {
  const query = normalize(searchText);
  if (!query) return index.map(({ item }) => item);
  const terms = query.split(" ");
  const matches = [];
  for (const entry of index) {
    const nameScore = literalScore(entry.nameValues, terms);
    const identifierScore = literalScore(entry.values, terms);
    const score =
      entry.name === query || normalize(entry.item) === query
        ? 0
        : nameScore !== null
          ? 1 + nameScore
          : identifierScore !== null
            ? 4 + identifierScore
            : normalize(descriptions[entry.item]).includes(query)
              ? 7
              : null;
    if (score !== null) matches.push({ item: entry.item, score });
  }
  // Concrete matches suppress guesses such as Walk for Talk. Descriptions
  // are literal phrases only, never inputs to the fuzzy matcher.
  if (matches.length === 0) {
    const matchers = terms.map((term) => createFuzzyMatcher(term));
    for (const entry of index) {
      let score = 0;
      for (let i = 0; i < terms.length; i += 1) {
        const match = matchers[i]({ values: entry.nameValues.filter((value) => value.length <= terms[i].length * 2) });
        if (match === null) {
          score = null;
          break;
        }
        score = Math.max(score, match);
      }
      if (score !== null) matches.push({ item: entry.item, score });
    }
  }
  return matches.sort((a, b) => a.score - b.score).map(({ item }) => item);
}
