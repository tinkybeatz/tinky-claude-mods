/**
 * What godmode is doing while it is on (D9, D22): `setup` scans the project and asks the
 * questionnaire, `change-setup` discusses a change to an earlier setup, `coding` runs the
 * PM loop.
 */
export type GodmodeMode = 'setup' | 'change-setup' | 'coding'

declare module 'claude-code' {
  interface PluginState {
    godmode: {
      /** True between `/godmode` and `/godmode off`; off, the session is plain Claude Code (D12). */
      isOn: boolean
      /** The mode godmode runs in; read only while `isOn`. */
      mode: GodmodeMode
    }
  }
}
