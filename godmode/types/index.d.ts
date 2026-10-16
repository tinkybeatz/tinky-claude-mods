/**
 * What godmode is doing while it is on (D9, D22): `setup` scans the project and asks the
 * questionnaire, `change-setup` discusses a change to an earlier setup, `coding` runs the
 * PM loop.
 */
export type GodmodeMode = 'setup' | 'change-setup' | 'coding'

/**
 * How much of the setup runs: `full` on a project with no note, `personal` when a
 * teammate's committed note is there and only this person's answers are missing (D61).
 */
export type SetupScope = 'full' | 'personal'

declare module 'claude-code' {
  interface PluginState {
    godmode: {
      /** True between `/godmode` and `/godmode off`; off, the session is plain Claude Code (D12). */
      isOn: boolean
      /** The mode godmode runs in; read only while `isOn`. */
      mode: GodmodeMode
      /** Which questions setup asks; read only in `setup` mode. */
      setupScope: SetupScope
      /** Conventions files edited since the setup note was written, each re-checked alone (D20). */
      recheck: string[]
    }
  }
}
