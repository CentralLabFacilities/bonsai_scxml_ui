/**
 * Locate an existing SCXML #_SLOTS declaration for one skill slot request.
 *
 * A mapping is identified by its state and key, not by its position or the
 * number of declarations for a state. In particular, a lone `Write` mapping
 * must NEVER be applied to an unmatched `Read` request. SCXML does not
 * supply evidence for such a direction-changing alias.
 *
 * When several declarations have the same state/key but different paths,
 * their intended read/write direction is ambiguous and stays unresolved.
 */
export function matchImportedSlotDeclaration(
  declarations = [],
  { fullSkillName = "", baseSkillName = "", slotKey = "" } = {},
) {
  if (!fullSkillName || !slotKey) return undefined;

  // Preserve the importer's previous state precedence, but do not treat
  // non-matching keys within a state as aliases for other requests.
  const groups = [
    declarations.filter((slot) => slot?.state === fullSkillName),
    declarations.filter((slot) => slot?.state === baseSkillName),
    declarations.filter((slot) => slot?.state === "*"),
  ];
  for (const candidates of groups) {
    if (candidates.length === 0) continue;
    const exact = candidates.filter((slot) => slot?.key === slotKey);
    return exact.length === 1 ? exact[0] : undefined;
  }
  return undefined;
}
