import { useEffect, useMemo, useRef, useState } from "react";
import { createSkillSearchIndex, rankSkillSearch } from "../../utils/skillSearch.js";

export function useSkillLibraryView({
  skills,
  selectedPackage,
  selectedSubPackage,
  searchText,
  activeFilter,
  fetchSkillData,
  refreshVersion = 0,
}) {
  const searchIndex = useMemo(() => createSkillSearchIndex(skills), [skills]);
  const hasSearch = Boolean(searchText?.trim());
  const [descriptionState, setDescriptionState] = useState(null);
  const descriptionCacheRef = useRef(null);
  const currentDescriptions =
    descriptionState?.skills === skills && descriptionState?.refreshVersion === refreshVersion
      ? descriptionState
      : null;
  useEffect(() => {
    if (!hasSearch || !fetchSkillData || !skills?.length) return;
    let cancelled = false;
    let cache = descriptionCacheRef.current;
    if (!cache || cache.refreshVersion !== refreshVersion || cache.fetchSkillData !== fetchSkillData) {
      cache = { refreshVersion, fetchSkillData, descriptions: {} };
      descriptionCacheRef.current = cache;
    }
    const descriptions = cache.descriptions;
    const missingSkills = skills.filter((skill) => !Object.hasOwn(descriptions, skill));
    const publish = (loading) => {
      if (!cancelled) setDescriptionState({ skills, refreshVersion, descriptions: { ...descriptions }, loading });
    };
    publish(missingSkills.length > 0);
    const load = async () => {
      for (let i = 0; i < missingSkills.length && !cancelled; i += 4) {
        const batch = missingSkills.slice(i, i + 4);
        const definitions = await Promise.all(batch.map((skill) => fetchSkillData(skill).catch(() => null)));
        if (cancelled) return;
        batch.forEach((skill, offset) => {
          if (definitions[offset]) descriptions[skill] = definitions[offset].description || "";
        });
        publish(i + 4 < missingSkills.length);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [hasSearch, skills, refreshVersion, fetchSkillData]);
  const descriptions = currentDescriptions?.descriptions;
  const isSearchingDescriptions =
    hasSearch &&
    Boolean(fetchSkillData) &&
    Boolean(skills?.length) &&
    (!currentDescriptions || currentDescriptions.loading);
  const searchedSkills = useMemo(
    () => rankSkillSearch(searchIndex, searchText, descriptions),
    [searchIndex, searchText, descriptions],
  );

  return useMemo(() => {
    const packages = [];
    const directSkills = [];
    const allSkills = skills || [];

    allSkills.forEach((skill) => {
      const afterSkills = skill.split("skills.")[1];
      if (!afterSkills) return;
      const parts = afterSkills.split(".");

      if (parts.length === 1) {
        directSkills.push(skill);
      } else {
        const packageName = parts[0];
        if (!packages.includes(packageName)) {
          packages.push(packageName);
        }
      }
    });

    let packageSkills = [];
    const subPackages = [];

    if (selectedPackage !== null) {
      allSkills.forEach((skill) => {
        const afterSkill = skill.split("skills.")[1];
        if (!afterSkill) return;
        const parts = afterSkill.split(".");

        if (parts[0] !== selectedPackage) return;

        if (selectedSubPackage === null) {
          if (parts.length === 2) {
            packageSkills.push(skill);
          }
          if (parts.length > 2) {
            const subPackageName = parts[1];
            if (!subPackages.includes(subPackageName)) {
              subPackages.push(subPackageName);
            }
          }
        } else if (parts[1] === selectedSubPackage && parts.length === 3) {
          packageSkills.push(skill);
        }
      });
    }

    const packageSkillNames = new Set(packageSkills);
    packageSkills = searchedSkills.filter((skill) => packageSkillNames.has(skill));

    return {
      packages,
      directSkills,
      packageSkills,
      subPackages,
      searchedSkills,
      isSearchingDescriptions,
      filteredSkills: searchedSkills.filter((skill) => activeFilter === "Everything" || skill.includes(activeFilter)),
    };
  }, [skills, selectedPackage, selectedSubPackage, searchedSkills, isSearchingDescriptions, activeFilter]);
}
