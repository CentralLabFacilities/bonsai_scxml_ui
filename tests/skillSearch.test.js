import test from "node:test";
import assert from "node:assert/strict";
import { createSkillSearchIndex, rankSkillSearch } from "../src/utils/skillSearch.js";

test("exact skill names outrank package words and suppress unrelated fuzzy guesses", () => {
  const skills = [
    "org.skills.talk.Listen",
    "org.skills.speech.TalkToPerson",
    "org.skills.motion.Walk",
    "org.skills.misc.TakeLongBreak",
    "org.skills.speech.Talk",
  ];
  const index = createSkillSearchIndex(skills);
  assert.deepEqual(rankSkillSearch(index, " TALK "), [skills[4], skills[1], skills[0]]);
  assert.deepEqual(new Set(rankSkillSearch(index, "speech talk")), new Set([skills[4], skills[1]]));
  assert.deepEqual(rankSkillSearch(index, "org.skills.speech.Talk"), [skills[4], skills[1]]);
  assert.deepEqual(rankSkillSearch(index, "  "), skills);
});

test("fallback tolerates abbreviations and typos in names, not scattered package characters", () => {
  const skills = ["org.skills.navigation.Walk", "org.skills.grasping.GraspObject", "org.skills.timing.TakeLongBreak"];
  const index = createSkillSearchIndex(skills);
  for (const query of ["wk", "wlk", "wlak"]) assert.deepEqual(rankSkillSearch(index, query), [skills[0]], query);
  assert.deepEqual(rankSkillSearch(index, "tlk"), []);
  assert.deepEqual(rankSkillSearch(index, "navigation grasp"), []);
  assert.deepEqual(rankSkillSearch(index, "navigtaion"), []);
});

test("descriptions match normalized literal phrases, below names and without fuzzy expansion", () => {
  const skills = ["org.skills.speech.Say", "org.skills.speech.Talk", "org.skills.motion.Walk"];
  const index = createSkillSearchIndex(skills);
  const descriptions = {
    [skills[0]]: "Talk to people. Greet a person using synthesized speech.",
    [skills[2]]: "Take a long walk.",
  };
  assert.deepEqual(rankSkillSearch(index, "talk", descriptions), [skills[1], skills[0]]);
  assert.deepEqual(rankSkillSearch(index, "  GREET\tA PERSON ", descriptions), [skills[0]]);
  assert.deepEqual(rankSkillSearch(index, "greet person", descriptions), []);
  assert.deepEqual(rankSkillSearch(index, "greet a persno", descriptions), []);
  assert.deepEqual(rankSkillSearch(index, "take long", descriptions), []);
});
