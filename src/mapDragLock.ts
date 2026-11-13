type Interaction = { enabled(): boolean; disable(): unknown; enable(): unknown };
const locks = new WeakMap<Interaction, { count: number; restore: boolean }>();

export function lockMapInteractions(interactions: Interaction[]) {
  const unique = [...new Set(interactions)];
  unique.forEach(interaction => {
    const lock = locks.get(interaction) ?? { count: 0, restore: interaction.enabled() };
    lock.count++;
    locks.set(interaction, lock);
    interaction.disable();
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unique.forEach(interaction => {
      const lock = locks.get(interaction)!;
      if (--lock.count > 0) return;
      locks.delete(interaction);
      if (lock.restore) interaction.enable();
    });
  };
}
